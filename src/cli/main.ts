import { errorText } from '../app/log.ts';
import { resolvePaths } from '../app/paths.ts';
import { buildDomains, createCommandEnv } from './commands.ts';
import { dispatch } from './registry.ts';

const result = dispatch(buildDomains(createCommandEnv(resolvePaths())), process.argv.slice(2));
if (result.kind === 'text') {
  console.log(result.text);
} else {
  try {
    await result.verb.run(result.flags);
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
}
