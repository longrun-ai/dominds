module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg?.name !== 'dominds') {
        return pkg;
      }

      const deps = pkg.dependencies;
      if (!deps || typeof deps !== 'object') {
        return pkg;
      }

      const current = deps['@longrun-ai/codex-auth'];
      if (typeof current !== 'string') {
        return pkg;
      }

      if (current.startsWith('link:') || current.startsWith('workspace:')) {
        return pkg;
      }

      deps['@longrun-ai/codex-auth'] = 'link:codex-auth';
      return pkg;
    },
  },
};

