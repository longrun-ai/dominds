/**
 * Main frontend application entry point for Dominds WebUI
 */

// Import CSS file
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';

import './components/dominds-app.tsx';
import './components/dominds-connection-status.tsx';

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
  // Load E2E test helper in development mode
  if (import.meta.env.DEV) {
    // Load DOM observation utilities first (required dependency)
    // Chain loading: load e2e-test-helper.js INSIDE obsScript.onload callback
    const obsScript = document.createElement('script');
    obsScript.src = '/testing/dom-observation-utils.js';
    obsScript.onload = () => {
      console.log('DOM observation utilities loaded');
      // NOW load E2E test helper - inside the callback to ensure dependency order
      const script = document.createElement('script');
      script.src = '/testing/e2e-test-helper.js';
      script.type = 'module';
      script.onload = () => console.log('E2E test helper loaded');
      script.onerror = () => console.error('Failed to load E2E test helper');
      document.head.appendChild(script);
    };
    obsScript.onerror = () => console.error('Failed to load DOM observation utilities');
    document.head.appendChild(obsScript);
  }

  // Create and mount the main application component
  const app = document.createElement('dominds-app');

  // Replace any existing content with our app
  document.body.innerHTML = '';
  document.body.appendChild(app);
});

// Export for module compatibility
export {};
