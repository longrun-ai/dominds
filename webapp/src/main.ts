/**
 * Main frontend application entry point for Dominds WebUI
 */

// Import CSS file
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';

import './components/dominds-app.tsx';
import './components/dominds-connection-status.tsx';
import './components/dominds-setup.tsx';

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
