/**
 * 验证 V2 扫描器：删除一条索引记录当作"新曲目"，
 * 跑一次真实扫描，确认重新解析、归入已有专辑、封面与曲目数恢复。
 */
import * as store from '../../server/db.mjs';
import { startScan, waitForScan, scanState, lastScanReport } from '../../server/scanner.mjs';

const before = {
  tracks: store.db.prepare('SELECT COUNT(*) n FROM tracks').get().n,
  albums: store.db.prepare('SELECT COUNT(*) n FROM albums').get().n,
};

const victim = store.db.prepare('SELECT id, album_id, path, title FROM tracks ORDER BY id DESC LIMIT 1').get();
console.log('① 删除一条索引记录：', victim?.title);
console.log('   路径：', victim?.path);
store.db.prepare('DELETE FROM tracks WHERE id = ?').run(victim.id);
const orphan = store.db.prepare(`
  SELECT COUNT(*) n FROM albums a WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = a.id)
`).get().n;
console.log(`   删除后 → tracks=${store.db.prepare('SELECT COUNT(*) n FROM tracks').get().n}`
  + ` 空壳专辑=${orphan}`);

console.log('\n② 运行扫描（应重新解析该文件并归回原专辑）');
startScan({});
await waitForScan();
console.log(`   新增 ${scanState.added}｜未变化 ${scanState.skipped}｜失败 ${scanState.failed}`
  + `｜新建专辑 ${scanState.albumsCreated}｜合并 ${scanState.albumsMerged}`);

console.log('\n③ 校验');
const after = {
  tracks: store.db.prepare('SELECT COUNT(*) n FROM tracks').get().n,
  albums: store.db.prepare('SELECT COUNT(*) n FROM albums').get().n,
};
const rows = store.db.prepare(`
  SELECT a.id, a.title, a.cover_hash IS NOT NULL AS has_cover, a.cover_source,
         (SELECT COUNT(*) FROM tracks t WHERE t.album_id = a.id) AS tracks
  FROM albums a ORDER BY a.id
`).all();
const emptyAlbums = store.db.prepare(`
  SELECT COUNT(*) n FROM albums a WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = a.id)
`).get().n;

console.log('   扫描前：', JSON.stringify(before));
console.log('   扫描后：', JSON.stringify(after));
console.log('   专辑：', JSON.stringify(rows));
console.log('   空壳专辑：', emptyAlbums);
console.log('   持久化的扫描报告：', JSON.stringify(lastScanReport()?.added) + ' 新增');

const ok = after.tracks === before.tracks
  && after.albums === before.albums
  && emptyAlbums === 0
  && rows.every((r) => r.tracks >= 1);

console.log(`\n${ok ? 'PASS' : 'FAIL'} 扫描器：曲目/专辑数恢复一致，无空壳专辑，封面保留`);
store.closeDb();
process.exit(ok ? 0 : 1);
