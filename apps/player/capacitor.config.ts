import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.minorillusion.player",
  appName: "Minor Illusion",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;
