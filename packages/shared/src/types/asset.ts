import type { AssetRetentionClass, AssetScanStatus } from "../constants.js";

export interface AssetImage {
  assetId: string;
  companyId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  scanStatus: AssetScanStatus;
  scanProvider: string | null;
  scanCompletedAt: Date | null;
  quarantinedAt: Date | null;
  quarantineReason: string | null;
  retentionClass: AssetRetentionClass;
  expiresAt: Date | null;
  legalHold: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
}
