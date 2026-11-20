import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'dev.nightlink',
  appName: 'Nightlink',
  webDir: 'dist',
  ios: {
    backgroundColor: '#0e0a14',
  },
  android: {
    // The page's own background, so nothing flashes white before it paints.
    backgroundColor: '#0d0d11',
  },
  plugins: {
    SystemBars: {
      // Light status bar icons, since the app is dark only. Without this
      // Android follows the phone's theme and draws dark icons on a dark app.
      // iOS already shows light ones, because the shell forces dark mode.
      style: 'DARK',
    },
    SplashScreen: {
      launchShowDuration: 1800,
      launchAutoHide: true,
      backgroundColor: '#17112b',
      showSpinner: false,
    },
    Keyboard: {
      // Shrink the web view itself, so 100dvh and every fixed element track the
      // keyboard the way a native view does and a focused input is never left
      // hidden underneath it.
      resize: KeyboardResize.Native,
      // The app is dark only. Without this the keyboard follows the device
      // appearance and comes up white under a dark UI.
      style: KeyboardStyle.Dark,
      // Tint the strip behind the keyboard with the real body background so the
      // show/hide animation never flashes the system colour.
      autoBackdropColor: 'dom',
    },
  },
};

export default config;
