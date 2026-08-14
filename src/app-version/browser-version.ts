declare const __COSTLIGHT_VERSION__: string;

export const APPLICATION_VERSION = typeof __COSTLIGHT_VERSION__ === "undefined"
  ? "development"
  : __COSTLIGHT_VERSION__;
