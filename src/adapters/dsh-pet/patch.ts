/**
 * 给打了 yoyo 补丁的桌宠（`patches/dsh-pet@*.patch`）排右键菜单：开桌宠前放进环境变量，
 * 桌宠的窗口进程继承下来，每次右键时照着藏掉自带项、把 yoyo 的项提到第一层。
 * 没打补丁的桌宠不认这个变量，菜单照旧，yoyo 的项还在「更多」里。
 */
import type { PetConfig } from '../../app/config.ts';

export const PET_MENU_ENV = 'YOYO_PET_MENU';

/** `hide` 按自带项的 action 名，`top` 按菜单项的 owner。 */
export function petMenuSpec(menu: PetConfig['menu'], owner: string): string {
  return JSON.stringify({ hide: menu.hide, top: menu.top ? [owner] : [] });
}
