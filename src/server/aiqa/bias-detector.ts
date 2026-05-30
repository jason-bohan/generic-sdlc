export interface DemographicGroup {
  label: string;
  approved: number;
  total: number;
}

export interface DisparateImpactResult {
  group: string;
  approvalRate: number;
  air: number;
  passes80Rule: boolean;
  detail: string;
}

const AIR_THRESHOLD = 0.8;

export function computeAdverseImpactRatio(
  groups: DemographicGroup[],
): { results: DisparateImpactResult[]; overallPass: boolean } {
  if (groups.length === 0) return { results: [], overallPass: true };

  const rates = groups.map((g) => ({
    label: g.label,
    approvalRate: g.total > 0 ? g.approved / g.total : 0,
  }));

  const highestRate = Math.max(...rates.map((r) => r.approvalRate), 0.001);

  const results: DisparateImpactResult[] = rates.map((r) => {
    const air = r.approvalRate / highestRate;
    return {
      group: r.label,
      approvalRate: Math.round(r.approvalRate * 10000) / 10000,
      air: Math.round(air * 10000) / 10000,
      passes80Rule: air >= AIR_THRESHOLD,
      detail: `${r.label}: ${(r.approvalRate * 100).toFixed(1)}% approval rate, AIR=${air.toFixed(3)} (threshold: ${AIR_THRESHOLD}). ${air >= AIR_THRESHOLD ? 'PASS' : 'FAIL'}`,
    };
  });

  return {
    results,
    overallPass: results.every((r) => r.passes80Rule),
  };
}

export interface ProtectedClassMutation {
  profileId: string;
  protectedAttribute: string;
  originalValue: string;
  mutatedValue: string;
  originalDecision: boolean;
  mutatedDecision: boolean;
  decisionChanged: boolean;
}

export interface BiasAuditConfig {
  protectedAttributes: string[];
  mutationValues: Record<string, string[]>;
}

const DEFAULT_BIAS_CONFIG: BiasAuditConfig = {
  protectedAttributes: ['race', 'gender', 'age', 'zipCode', 'maritalStatus'],
  mutationValues: {
    race: ['white', 'black', 'asian', 'hispanic', 'other'],
    gender: ['male', 'female', 'non-binary'],
    age: ['25', '45', '65', '75'],
    zipCode: ['10001', '90210', '60614', '77002', '33101'],
    maritalStatus: ['single', 'married', 'divorced'],
  },
};

export interface DecisionFn {
  (profile: Record<string, unknown>): boolean;
}

export function runBiasMutationTest(
  baseProfiles: Array<Record<string, unknown>>,
  decisionFn: DecisionFn,
  config: BiasAuditConfig = DEFAULT_BIAS_CONFIG,
): { mutations: ProtectedClassMutation[]; flipRate: number; summary: string } {
  const mutations: ProtectedClassMutation[] = [];
  let totalTests = 0;

  for (let i = 0; i < baseProfiles.length; i++) {
    const profile = baseProfiles[i];
    const profileId = String(profile.id ?? i);
    const originalDecision = decisionFn(profile);

    for (const attr of config.protectedAttributes) {
      const values = config.mutationValues[attr];
      if (!values || values.length === 0) continue;
      const originalValue = String(profile[attr] ?? 'unknown');

      for (const mutatedValue of values) {
        if (mutatedValue === originalValue) continue;
        const mutatedProfile = { ...profile, [attr]: mutatedValue };
        const mutatedDecision = decisionFn(mutatedProfile);
        totalTests++;

        if (mutatedDecision !== originalDecision) {
          mutations.push({
            profileId,
            protectedAttribute: attr,
            originalValue,
            mutatedValue,
            originalDecision,
            mutatedDecision,
            decisionChanged: true,
          });
        }
      }
    }
  }

  const flipRate = totalTests > 0 ? Math.round((mutations.length / totalTests) * 10000) / 10000 : 0;
  const summary = `Bias mutation test: ${mutations.length} decision flips across ${totalTests} mutations (flip rate: ${(flipRate * 100).toFixed(2)}%). `
    + (flipRate > 0.05 ? 'WARNING: High flip rate suggests protected attribute sensitivity.' : 'Low flip rate — no systemic proxy bias detected.');

  return { mutations, flipRate, summary };
}

export function computeIntersectionalAIR(
  groups: DemographicGroup[],
): { results: DisparateImpactResult[]; overallPass: boolean; worstGroup: string | null } {
  const { results, overallPass } = computeAdverseImpactRatio(groups);
  const sorted = [...results].sort((a, b) => a.air - b.air);
  const worstGroup = sorted.length > 0 && sorted[0].air < AIR_THRESHOLD ? sorted[0].group : null;
  return { results, overallPass, worstGroup };
}
