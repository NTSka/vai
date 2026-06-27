export const localEnvironmentNames = ["development", "test"] as const;

export type LocalEnvironmentName = (typeof localEnvironmentNames)[number];
