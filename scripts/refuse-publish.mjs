#!/usr/bin/env node
// Last line of defense against a registry publish.
//
// Every manifest is marked private, so a registry would already refuse. This
// hook covers the case where `private` was removed: it fails the publish
// lifecycle itself rather than letting the package leave the machine.
console.error(
  [
    '',
    'Refusing to publish.',
    '',
    'EvuHarness releases through GitHub Releases only. Enabling a registry',
    'publish requires a dedicated human approval gate: a separate workflow job',
    'bound to a protected environment with required reviewers.',
    '',
    'If you are seeing this during ordinary development, you probably meant',
    '`pnpm pack` to inspect the tarball contents.',
    '',
  ].join('\n'),
);
process.exit(1);
