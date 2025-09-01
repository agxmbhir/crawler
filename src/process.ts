import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { loadGraph } from './process/load';
import { Labeller } from './process/labeller';

dotenv.config();

async function main() {
  const inDir = path.join(process.cwd(), 'out', 'jsonl');
  const outDir = path.join(process.cwd(), 'out', 'processed');
  const labelsDir = path.join(outDir, 'labels');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { }
  try { fs.mkdirSync(labelsDir, { recursive: true }); } catch { }

  const g = await loadGraph(inDir);

  // Dump raw graph for inspection
  const pages = Array.from(g.pagesByCanon.values());
  const edgesByFrom = Array.from(g.edgesByFromCanon.entries()).map(([fromCanon, edges]) => ({ fromCanon, edges }));
  const navByDest = Array.from(g.navByDestCanon.entries()).map(([toCanon, edges]) => ({ toCanon, edges }));
  const rawOut = { inDir, pages, edgesByFrom, navByDest };
  const rawOutPath = path.join(outDir, 'graph_raw.json');
  fs.writeFileSync(rawOutPath, JSON.stringify(rawOut, null, 2));
  console.log(`Wrote full graph dump to ${rawOutPath}`);

  // Label using Anthropic (batched)
  const labeller = new Labeller({});
  const site = await labeller.labelSite(g);
  fs.writeFileSync(path.join(labelsDir, 'site_label.json'), JSON.stringify(site, null, 2));

  await labeller.labelPagesBatched(g, path.join(labelsDir, 'page_labels.jsonl'), site, {
    batchSize: 10,
    concurrency: 3,
  });
  console.log(`Wrote site_label.json and page_labels.jsonl to ${labelsDir}`);
}

main().catch((err) => { console.error(err); process.exit(1); }); 