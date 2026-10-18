// prepack: npm only packs files from this package's directory, but README.md and LICENSE live at the
// repository root (where GitHub shows them). Copy them in before packing. The copies are git-ignored.
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(packageDir, '..', '..');

for (const file of ['README.md', 'LICENSE']) {
  copyFileSync(join(repoRoot, file), join(packageDir, file));
  console.log(`prepack: copied ${file} from the repository root`);
}
