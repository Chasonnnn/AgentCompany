import type { Db } from "@paperclipai/db";
import type { InstanceGeneralSettings } from "@paperclipai/shared";
import { loadConfig } from "../config.js";
import { instanceSettingsService } from "./instance-settings.js";

export interface EnterprisePolicySnapshot {
  deploymentMode: ReturnType<typeof loadConfig>["deploymentMode"];
  deploymentExposure: ReturnType<typeof loadConfig>["deploymentExposure"];
  settings: InstanceGeneralSettings["enterprisePolicy"];
}

export function enterprisePolicyService(db: Db) {
  const instanceSettings = instanceSettingsService(db);

  return {
    get: async (): Promise<EnterprisePolicySnapshot> => {
      const runtime = loadConfig();
      const general = await instanceSettings.getGeneral();
      return {
        deploymentMode: runtime.deploymentMode,
        deploymentExposure: runtime.deploymentExposure,
        settings: general.enterprisePolicy,
      };
    },
  };
}
