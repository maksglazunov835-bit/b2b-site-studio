export const DESIGN_PERMISSION_PROFILE = 'b2b-design-json';

// Official permission-profile syntax. No root read or shared temp write grant.
export function permissionArguments() {
  const profile = DESIGN_PERMISSION_PROFILE;
  return [
    '-c',
    `default_permissions="${profile}"`,
    '-c',
    `permissions.${profile}.filesystem={ ":root"="deny", ":minimal"="read", ":workspace_roots"={ "."="read", "output"="write" } }`,
    '-c',
    `permissions.${profile}.network.enabled=false`,
    '-c',
    'windows.sandbox="elevated"',
    '-c',
    'windows.sandbox_private_desktop=true',
    '-c',
    'approval_policy="never"',
  ];
}
