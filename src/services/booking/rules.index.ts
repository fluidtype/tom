import { demoRules } from './rules.demo';

export type TenantRules = {
  slotMinutes: number;
  tableDuration: number;
  capacity: number;
  openingHours: Record<string, string[]>;
};

export const tenantRules: Record<string, TenantRules> = {
  demo: demoRules,
};
