/**
 * Main frontend application entry point for Dominds WebUI
 */

// Import CSS file
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';

import './assets/base.css';
import './assets/tokens.css';

import './components/dominds-app.tsx';
import './components/dominds-connection-status.tsx';

// Global CSS variables for theming
const applyTheme = () => {
  const style = document.createElement('style');
  style.textContent = `
    :root[data-theme="light"] {
      /* Light theme */
      --dominds-bg: #ffffff;
      --dominds-fg: #333333;
      --dominds-header-bg: #f8f9fa;
      --dominds-sidebar-bg: #f8f9fa;
      --dominds-toolbar-bg: #f8f9fa;
      --dominds-primary: #007acc;
      --dominds-primary-hover: #005ea6;
      --dominds-secondary: #6c757d;
      --dominds-secondary-hover: #545b62;
      --dominds-success: #28a745;
      --dominds-warning: #ffc107;
      --dominds-danger: #dc3545;
      --dominds-info: #007bff;
      --dominds-disabled: #cccccc;
      --dominds-muted: #666666;
      --dominds-border: #e0e0e0;
      --dominds-hover: #f0f0f0;
      
      /* Status backgrounds */
      --dominds-success-bg: #d4edda;
      --dominds-success-border: #c3e6cb;
      --dominds-warning-bg: #fff3cd;
      --dominds-warning-border: #ffeaa7;
      --dominds-danger-bg: #f8d7da;
      --dominds-danger-border: #f5c6cb;
      --dominds-info-bg: #cce7ff;
      --dominds-info-border: #99d1ff;
    }

    :root[data-theme="dark"] {
      /* Dark theme */
      --dominds-bg: #1a1a1a;
      --dominds-fg: #e0e0e0;
      --dominds-header-bg: #2d2d2d;
      --dominds-sidebar-bg: #2d2d2d;
      --dominds-toolbar-bg: #2d2d2d;
      --dominds-primary: #4aa3ff;
      --dominds-primary-hover: #3388dd;
      --dominds-secondary: #888888;
      --dominds-secondary-hover: #666666;
      --dominds-success: #4caf50;
      --dominds-warning: #ff9800;
      --dominds-danger: #f44336;
      --dominds-info: #2196f3;
      --dominds-disabled: #555555;
      --dominds-muted: #aaaaaa;
      --dominds-border: #444444;
      --dominds-hover: #333333;
      
      /* Status backgrounds for dark theme */
      --dominds-success-bg: #1e3a1e;
      --dominds-success-border: #2d5a2d;
      --dominds-warning-bg: #3a2e1e;
      --dominds-warning-border: #5a3a2d;
      --dominds-danger-bg: #3a1e1e;
      --dominds-danger-border: #5a2d2d;
      --dominds-info-bg: #1e2e3a;
      --dominds-info-border: #2d3a5a;
    }

    /* Fallback for when data-theme is not set */
    :root:not([data-theme]) {
      /* Light theme (default) */
      --dominds-bg: #ffffff;
      --dominds-fg: #333333;
      --dominds-header-bg: #f8f9fa;
      --dominds-sidebar-bg: #f8f9fa;
      --dominds-toolbar-bg: #f8f9fa;
      --dominds-primary: #007acc;
      --dominds-primary-hover: #005ea6;
      --dominds-secondary: #6c757d;
      --dominds-secondary-hover: #545b62;
      --dominds-success: #28a745;
      --dominds-warning: #ffc107;
      --dominds-danger: #dc3545;
      --dominds-info: #007bff;
      --dominds-disabled: #cccccc;
      --dominds-muted: #666666;
      --dominds-border: #e0e0e0;
      --dominds-hover: #f0f0f0;
      
      /* Status backgrounds */
      --dominds-success-bg: #d4edda;
      --dominds-success-border: #c3e6cb;
      --dominds-warning-bg: #fff3cd;
      --dominds-warning-border: #ffeaa7;
      --dominds-danger-bg: #f8d7da;
      --dominds-danger-border: #f5c6cb;
      --dominds-info-bg: #cce7ff;
      --dominds-info-border: #99d1ff;
    }

    /* System preference fallback when no theme is set */
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme]) {
        /* Dark theme */
        --dominds-bg: #1a1a1a;
        --dominds-fg: #e0e0e0;
        --dominds-header-bg: #2d2d2d;
        --dominds-sidebar-bg: #2d2d2d;
        --dominds-toolbar-bg: #2d2d2d;
        --dominds-primary: #4aa3ff;
        --dominds-primary-hover: #3388dd;
        --dominds-secondary: #888888;
        --dominds-secondary-hover: #666666;
        --dominds-success: #4caf50;
        --dominds-warning: #ff9800;
        --dominds-danger: #f44336;
        --dominds-info: #2196f3;
        --dominds-disabled: #555555;
        --dominds-muted: #aaaaaa;
        --dominds-border: #444444;
        --dominds-hover: #333333;
        
        /* Status backgrounds for dark theme */
        --dominds-success-bg: #1e3a1e;
        --dominds-success-border: #2d5a2d;
        --dominds-warning-bg: #3a2e1e;
        --dominds-warning-border: #5a3a2d;
        --dominds-danger-bg: #3a1e1e;
        --dominds-danger-border: #5a2d2d;
        --dominds-info-bg: #1e2e3a;
        --dominds-info-border: #2d3a5a;
      }
    }
  `;
  document.head.appendChild(style);

  // Initialize theme if not already set
  const currentTheme = document.documentElement.getAttribute('data-theme');
  if (!currentTheme) {
    const savedTheme = localStorage.getItem('dominds-theme');
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
    const theme = savedTheme || systemTheme;
    document.documentElement.setAttribute('data-theme', theme);
  }
};

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
  // Apply theme
  applyTheme();

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
