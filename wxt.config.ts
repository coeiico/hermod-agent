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
    ],
    host_permissions: ['https://api.anthropic.com/*', '<all_urls>'],
    action: {
      default_title: 'Hermod Agent',
    },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Space' },
        description: 'Open the Hermod prompt',
      },
    },
  },
});
