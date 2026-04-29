import { test, expect, Page } from '@playwright/test';

// Diagnostic: dump every wheel's detected rollAxis per car. Runs as a normal
// test so you get a pass/fail signal — assertion is only that all four
// wheels of a given car agree on their roll axis. The console.log is the
// useful part: it prints the actual axis vectors so we can confirm
// detection picked the right axis for each car.

const CARS = ['Beatall', 'Landyroamer', 'Toyoyo Highlight', 'Tristar Racer'];

async function gotoLibraryAndPick(page: Page, name: string) {
  await page.goto('/library.html');
  await page.waitForFunction(() => (window as any).__lib !== undefined);
  await page.evaluate((target) => {
    const lib = (window as any).__lib;
    const idx = lib.assets.findIndex((a: { name: string }) => a.name === target);
    return lib.showAsset(idx);
  }, name);
  await page.waitForFunction((target) => {
    const lib = (window as any).__lib;
    return lib.activeAsset && lib.assets[lib.activeIndex]?.name === target;
  }, name, { timeout: 15_000 });
}

for (const name of CARS) {
  test(`${name}: all four wheels share a roll axis`, async ({ page }) => {
    await gotoLibraryAndPick(page, name);
    const positions = await page.evaluate(() => {
      const THREE = (window as any).__lib.THREE;
      const ws = (window as any).__lib.wheelState;
      return ws.wheels.map((w: any) => {
        const bb = new THREE.Box3().setFromObject(w.obj);
        const c = new THREE.Vector3(); bb.getCenter(c);
        return { name: w.obj.name, x: c.x, z: c.z };
      });
    });

    const meshDumps = await page.evaluate(() => {
      const THREE = (window as any).__lib.THREE;
      const ws = (window as any).__lib.wheelState;
      return ws.wheels.map((w: any) => {
        const meshes: { name: string; size: [number, number, number]; rotation: [number, number, number] }[] = [];
        w.obj.traverse((node: any) => {
          if (!node.isMesh || !node.geometry) return;
          if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
          const bb = node.geometry.boundingBox.clone();
          const s = new THREE.Vector3(); bb.getSize(s);
          // Mesh's local rotation (relative to its parent — which is the wheel
          // object, which is now a child of the pivot).
          meshes.push({
            name: node.name,
            size: [s.x, s.y, s.z],
            rotation: [node.rotation.x, node.rotation.y, node.rotation.z],
          });
        });
        return { wheel: w.obj.name, meshes };
      });
    });
    console.log(`${name} mesh dump:`);
    for (const w of meshDumps) {
      console.log(`  ${w.wheel}:`);
      for (const m of w.meshes) console.log(`    ${m.name} size=[${m.size.map((s: number) => s.toFixed(3)).join(',')}] rot=[${m.rotation.map((r: number) => r.toFixed(3)).join(',')}]`);
    }
    console.log(`${name} world positions:`);
    for (const p of positions) console.log(`  ${p.name}: x=${p.x.toFixed(3)} z=${p.z.toFixed(3)}`);

    const axes = await page.evaluate(() => {
      const THREE = (window as any).__lib.THREE;
      const ws = (window as any).__lib.wheelState;
      return ws.wheels.map((w: any) => {
        // Compute the wheel's bbox in pivot's local frame so we can see
        // which axis the detector saw as smallest.
        const pivot = w.obj;
        pivot.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
        const bb = new THREE.Box3();
        bb.makeEmpty();
        pivot.traverse((node: any) => {
          if (!node.isMesh || !node.geometry) return;
          if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
          const mb = node.geometry.boundingBox.clone();
          const m2f = new THREE.Matrix4().multiplyMatrices(inv, node.matrixWorld);
          mb.applyMatrix4(m2f);
          bb.union(mb);
        });
        const size = new THREE.Vector3(); bb.getSize(size);
        return {
          name: w.obj.name,
          axle: w.axle,
          side: w.side,
          rollAxis: [w.rollAxis.x, w.rollAxis.y, w.rollAxis.z],
          steerAxis: [w.steerAxis.x, w.steerAxis.y, w.steerAxis.z],
          bboxSize: [size.x.toFixed(6), size.y.toFixed(6), size.z.toFixed(6)],
        };
      });
    });
    console.log(`\n${name} detected wheel axes:`);
    for (const a of axes) console.log(`  ${a.axle}-${a.side} ${a.name}: roll=[${a.rollAxis.join(',')}] bboxSize=[${a.bboxSize.join(',')}]`);

    // All four wheels should detect the same roll axis (within rounding).
    // If they don't, our axle detection is unstable and rolling will look
    // disjointed across the car.
    const first = axes[0].rollAxis;
    for (const a of axes) {
      expect(a.rollAxis, `${a.name} matches first wheel's axis`).toEqual(first);
    }
  });
}
