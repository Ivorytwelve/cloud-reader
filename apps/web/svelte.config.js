import adapter from '@sveltejs/adapter-static';
import preprocess from 'svelte-preprocess';

const base = process.env.BASE_PATH || '';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    immutable: true
  },

  preprocess: [
    preprocess({
      postcss: true
    })
  ],

  kit: {
    adapter: adapter({
      fallback: '404.html'
    }),
    paths: {
      base
    }
  }
};

export default config;
