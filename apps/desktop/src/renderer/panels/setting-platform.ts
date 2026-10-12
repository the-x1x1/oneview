import type { ProviderSettingDefinition } from '@worldview/provider-sdk';

const PLATFORM_NAMES: Record<string, string> = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' };

/** A platform's name for a sentence (`win32` → Windows); an unknown one as it is. */
export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

/**
 * Why a setting cannot be used on this computer, or undefined when it can: a setting that
 * names its platforms (`platforms`, provider-sdk ProviderSettingDefinition) is shown without
 * its control elsewhere, with this line instead of the control. A browser or demo page
 * (no platform) is treated as able, so nothing is hidden where it cannot be judged.
 */
export function settingUnavailableNote(
  def: Pick<ProviderSettingDefinition, 'platforms'>,
  platform: string | undefined,
): string | undefined {
  if (!def.platforms?.length || !platform || def.platforms.includes(platform as 'linux')) return undefined;
  const on = def.platforms.map(platformName);
  const where = on.length === 1 ? on[0]! : `${on.slice(0, -1).join(', ')} and ${on[on.length - 1]!}`;
  return `Not available on ${platformName(platform)}: this works on ${where} only.`;
}
