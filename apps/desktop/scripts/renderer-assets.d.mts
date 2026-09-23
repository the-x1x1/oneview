/** Types for the plain-ESM helper the build script and both Vite configs share. */
export declare const appDir: string;
export declare const workspaceRoot: string;
export declare const VITE_PUBLIC_DIR: string;
export declare const CESIUM_PUBLIC_DIR: string;
export declare const CESIUM_SUBDIRS: readonly string[];
export declare const MAPLIBRE_PUBLIC_DIR: string;
export declare function packageFileCandidates(pkg: string, relative: string): string[];
export declare function cesiumBuildDirCandidates(): string[];
export declare function findCesiumBuildDir(): string | undefined;
export declare function stageCesiumAssets(): string;
export declare const MAPLIBRE_WORKER_PATH: string;
export declare const MAPLIBRE_RUNTIME_FILES: readonly string[];
export declare function maplibrePackageDir(): string;
export declare function stageMapLibreAssets(): { dir: string; version: string; files: string[] };
export declare const BUNDLED_ASSET_DIRS: readonly string[];
export declare const BUNDLED_ASSETS_SOURCE: string;
export declare function stageBundledAssets(): string[];
export declare function stageRendererAssets(): {
  cesium: string;
  maplibre: { dir: string; version: string; files: string[] };
  bundled: string[];
};
