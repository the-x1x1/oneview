import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGpu, graphicsProfile, pixelRatioFor, resolveGraphicsQuality } from './graphics.js';

test('classifyGpu: real WebGL renderer strings', () => {
  const cases: Array<[string, ReturnType<typeof classifyGpu>]> = [
    ['ANGLE (AMD, AMD Radeon(TM) 740M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002704) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
    ['ANGLE (AMD, AMD Radeon RX 7900 XTX (0x0000744C) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
    ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'software'],
    ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'software'],
    ['Something New 9000', 'unknown'],
  ];
  for (const [s, want] of cases) assert.equal(classifyGpu(s), want, s);
  assert.equal(classifyGpu(undefined), 'unknown');
});

test('Auto resolves by GPU class; an explicit choice wins', () => {
  assert.equal(resolveGraphicsQuality('auto', 'NVIDIA GeForce RTX 3060'), 'high');
  assert.equal(resolveGraphicsQuality('auto', 'AMD Radeon(TM) 740M Graphics'), 'balanced');
  assert.equal(resolveGraphicsQuality('auto', 'SwiftShader'), 'low');
  assert.equal(resolveGraphicsQuality('auto', undefined), 'balanced');
  assert.equal(resolveGraphicsQuality('low', 'NVIDIA GeForce RTX 3060'), 'low');
  assert.equal(resolveGraphicsQuality(undefined, 'NVIDIA GeForce RTX 3060'), 'high');
});

test('profiles get strictly cheaper from high to low', () => {
  const [h, b, l] = (['high', 'balanced', 'low'] as const).map(graphicsProfile);
  assert.ok(h!.msaaSamples > b!.msaaSamples && b!.msaaSamples > l!.msaaSamples);
  assert.ok(h!.maxPixelRatio > b!.maxPixelRatio && b!.maxPixelRatio > l!.maxPixelRatio);
  assert.ok(
    h!.maximumScreenSpaceError < b!.maximumScreenSpaceError && b!.maximumScreenSpaceError < l!.maximumScreenSpaceError,
  );
  assert.equal(l!.fxaa, true, 'low swaps MSAA for FXAA');
});

test('pixelRatioFor never draws above the display or the profile', () => {
  assert.equal(pixelRatioFor(graphicsProfile('high'), 1.25), 1.25);
  assert.equal(pixelRatioFor(graphicsProfile('high'), 3), 2);
  assert.equal(pixelRatioFor(graphicsProfile('balanced'), 1.5), 1.25);
  assert.equal(pixelRatioFor(graphicsProfile('low'), 1.5), 1);
  assert.equal(pixelRatioFor(graphicsProfile('low'), Number.NaN), 1);
});
