/** 只打包本机构建：随包 Node 与原生模块不能被跨平台标签伪装。 */
export function packagingOptions(root, platform, arch, runtime) {
  if (runtime.platform !== platform || runtime.arch !== arch)
    throw new Error('随包 Node / 原生模块的目标平台不匹配；请在目标平台和架构重新构建。');
  const [major, minor] = String(runtime.nodeVersion).replace(/^v/, '').split('.').map(Number);
  if (!(major > 22 || (major === 22 && minor >= 19))) throw new Error('随包 Node 版本不符合要求。');
  return {
    dir: root + '/desktop/dist',
    out: root + '/desktop/release',
    name: 'agentlab',
    executableName: 'agentlab',
    platform,
    arch,
    asar: false,
    prune: false,
    overwrite: true,
    ...(platform === 'darwin'
      ? {
          appBundleId: 'com.changerr.agentlab',
          appCategoryType: 'public.app-category.developer-tools',
          darwinDarkModeSupport: true,
          extendInfo: { NSHighResolutionCapable: true },
        }
      : {}),
  };
}
