import type { PluginOption } from 'vite';

export function basePathRewrite(prefixes: string[]): PluginOption {
  const base = process.env.BASE_PATH || '/';
  return {
    name: 'base-path-rewrite',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('node_modules')) return null;
      if (!/\.(tsx?|scss|css)$/.test(id)) return null;
      let transformed = code;
      let hasChanges = false;
      for (const prefix of prefixes) {
        for (const quote of ['"', "'", '`']) {
          const pattern = `${quote}${prefix}`;
          const replacement = `${quote}${base}${prefix.slice(1)}`;
          if (transformed.includes(pattern)) {
            transformed = transformed.replaceAll(pattern, replacement);
            hasChanges = true;
          }
        }
      }
      return hasChanges ? { code: transformed, map: null } : null;
    },
  };
}
