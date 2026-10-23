#!/usr/bin/env node
import { dispatch } from '../src/cli.js';
import { domains } from '../src/commands.js';

const result = dispatch(domains, process.argv.slice(2));
if (result.kind === 'text') {
  console.log(result.text);
} else {
  await result.verb.run(result.flags);
}
