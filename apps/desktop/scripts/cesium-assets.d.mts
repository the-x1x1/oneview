/** Types for the plain-ESM helper the build script and both Vite configs share. */
export declare const appDir: string;
export declare const workspaceRoot: string;
export declare const VITE_PUBLIC_DIR: string;
export declare const CESIUM_PUBLIC_DIR: string;
export declare const CESIUM_SUBDIRS: readonly string[];
export declare function cesiumBuildDirCandidates(): string[];
export declare function findCesiumBuildDir(): string | undefined;
export declare function stageCesiumAssets(): string;
