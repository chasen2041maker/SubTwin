import {
  installMainWorldNetflixRuntime,
  type NetflixRuntimeWindow,
} from '../src/netflix/runtime';

export default defineContentScript({
  matches: ['https://www.netflix.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  noScriptStartedPostMessage: true,
  main() {
    installMainWorldNetflixRuntime({
      window: window as unknown as NetflixRuntimeWindow,
    });
  },
});
