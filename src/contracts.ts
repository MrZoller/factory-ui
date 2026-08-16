export const FACTORY_PHASES = ["specify", "plan", "build", "idle"] as const;

export type FactoryPhase = (typeof FACTORY_PHASES)[number];

export interface RepositoryConfig {
  name: string;
  path: string;
}

export interface PeerConfig {
  name: string;
  origin: string;
}

export interface AppConfig {
  machine: string;
  repositories: RepositoryConfig[];
  peers: PeerConfig[];
  port: number;
}

export type RepositorySnapshot =
  | {
      name: string;
      status: "available";
      project: string;
      phase: FactoryPhase;
    }
  | {
      name: string;
      status: "unavailable";
      warning: string;
    };

export interface FleetSnapshot {
  hostname: string;
  repositories: RepositorySnapshot[];
  peers: PeerConfig[];
}
