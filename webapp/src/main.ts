/**
 * Main frontend application entry point for Dominds WebUI
 */

// Import CSS file
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';
import './assets/base.css';
import './assets/tokens.css';

import './components/dominds-app';
import './components/dominds-connection-status';
import './components/dominds-setup';

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
  // Create and mount the main application component
  const path = window.location.pathname;
  const isSetup = path === '/setup' || path === '/setup/';
  const app = document.createElement(isSetup ? 'dominds-setup' : 'dominds-app');

  // Replace any existing content with our app
  document.body.innerHTML = '';
  document.body.appendChild(app);
});

// Export for module compatibility
export {};
