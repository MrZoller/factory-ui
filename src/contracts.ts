export const FACTORY_PHASES = ["specify", "plan", "build", "idle"] as const;

export type FactoryPhase = (typeof FACTORY_PHASES)[number];

export interface RepositorySource {
  name: string;
  path: string;
}

export interface RepositoryConfig extends RepositorySource {
  githubUrl: string;
}

export interface PeerConfig {
  name: string;
  origin: string;
}

export interface AppConfigSource {
  machine: string;
  repositories: RepositorySource[];
  peers: PeerConfig[];
  port: number;
  bind?: string;
  developmentOrigins?: string[];
}

export interface AppConfig extends AppConfigSource {
  repositories: RepositoryConfig[];
  bind: string;
  developmentOrigins: string[];
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
