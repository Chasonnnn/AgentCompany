import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { loadConfig } from "../../config.js";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const DNS_LOOKUP_TIMEOUT_MS = 5_000;
const KNOWN_METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.azure.internal",
]);

function parseIpv4Address(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const parsed = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    return Number(part);
  });
  if (parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parsed as [number, number, number, number];
}

function parseMappedIpv4Hex(address: string): string | null {
  const match = address.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return null;
  const hi = Number.parseInt(match[1]!, 16);
  const lo = Number.parseInt(match[2]!, 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isLoopbackIpv4(address: string): boolean {
  const octets = parseIpv4Address(address);
  return Boolean(octets && octets[0] === 127);
}

function isLoopbackIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("::ffff:")) {
    const mappedIpv4 = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedIpv4?.[1]) return isLoopbackIpv4(mappedIpv4[1]);
    const mappedIpv4Hex = parseMappedIpv4Hex(lower);
    if (mappedIpv4Hex) return isLoopbackIpv4(mappedIpv4Hex);
  }
  return false;
}

function isExplicitLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost") return true;
  const version = isIP(normalized);
  if (version === 4) return isLoopbackIpv4(normalized);
  if (version === 6) return isLoopbackIpv6(normalized);
  return false;
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const octets = parseIpv4Address(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateOrReservedIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const mappedIpv4 = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedIpv4?.[1]) return isPrivateOrReservedIpv4(mappedIpv4[1]);
    const mappedIpv4Hex = parseMappedIpv4Hex(lower);
    if (mappedIpv4Hex) return isPrivateOrReservedIpv4(mappedIpv4Hex);
    return true;
  }
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith("ff")) return true;
  if (lower === "100::" || lower.startsWith("100:")) return true;
  if (lower.startsWith("2001:db8:") || lower === "2001:db8::") return true;
  if (lower.startsWith("2001:2:") || lower === "2001:2::") return true;
  if (lower.startsWith("2002:")) return true;
  if (lower.startsWith("64:ff9b:")) return true;
  return false;
}

function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !isPrivateOrReservedIpv4(address);
  if (version === 6) return !isPrivateOrReservedIpv6(address);
  return false;
}

function isLoopbackAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isLoopbackIpv4(address);
  if (version === 6) return isLoopbackIpv6(address);
  return false;
}

async function resolveHostname(hostname: string): Promise<string[]> {
  const version = isIP(hostname);
  if (version !== 0) return [hostname];

  const lookupPromise = dnsLookup(hostname, { all: true, verbatim: true });
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`HTTP adapter DNS lookup timed out after ${DNS_LOOKUP_TIMEOUT_MS}ms for ${hostname}`)),
      DNS_LOOKUP_TIMEOUT_MS,
    );
  });

  const results = await Promise.race([lookupPromise, timeoutPromise]);
  const addresses = results.map((result) => result.address);
  if (addresses.length === 0) {
    throw new Error(`HTTP adapter hostname did not resolve to any addresses: ${hostname}`);
  }
  return addresses;
}

export async function validateTarget(urlValue: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error(`Invalid URL: ${urlValue}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`HTTP adapter only supports http:// and https:// URLs (received ${url.protocol})`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const lowerHostname = hostname.toLowerCase();
  if (KNOWN_METADATA_HOSTNAMES.has(lowerHostname)) {
    throw new Error(`HTTP adapter blocks metadata hostnames: ${hostname}`);
  }

  const deploymentMode = loadConfig().deploymentMode;
  const explicitLoopbackHost = isExplicitLoopbackHost(hostname);
  const resolvedAddresses = await resolveHostname(hostname);

  if (resolvedAddresses.some((address) => !isPublicIpAddress(address))) {
    const allowLocalLoopback =
      deploymentMode === "local_trusted" &&
      explicitLoopbackHost &&
      resolvedAddresses.every((address) => isLoopbackAddress(address));
    if (!allowLocalLoopback) {
      throw new Error(
        "HTTP adapter blocks local, private, link-local, metadata, multicast, and reserved targets",
      );
    }
  }

  if (url.protocol !== "https:" && !(deploymentMode === "local_trusted" && explicitLoopbackHost)) {
    throw new Error("HTTP adapter requires https:// for non-loopback targets");
  }

  return url;
}
