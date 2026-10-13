import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Hermod Agent',
    description: 'Plain-language browser commands for Vivaldi, powered by Claude.',
    permissions: [
      'tabs',
      'storage',
      'sessions',
      'bookmarks',
      'history',
      'downloads',
      'scripting',
      'system.display',
      // Copying to the clipboard goes through an offscreen document.
      'offscreen',
      'clipboardWrite',
      // Saved threads can outgrow storage.local's 10 MB default.
      'unlimitedStorage',
    ],
    host_permissions: ['https://api.anthropic.com/*', '<all_urls>'],
    action: {
      default_title: 'Hermod Agent',
    },
    commands: {
      // Two shortcuts; the user keeps whichever suits their browser. The
      // browser's own popup command, and Hermod's quick window, which always
      // opens over the window in use (Vivaldi can open the popup in another
      // window; see lib/detached-window.ts).
      _execute_action: {
        suggested_key: { default: 'Alt+Space' },
        description: 'Open the Hermod popup',
      },
      'open-prompt': {
        suggested_key: { default: 'Alt+Shift+Space' },
        description: 'Open the Hermod prompt over the window in use',
      },
    },
  },
});
