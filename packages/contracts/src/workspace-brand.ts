/** Organization identity configured by the workspace owner. No document styling is applied by this profile. */
export interface WorkspaceBrandData {
  schemaVersion: 1;
  organization: {
    name: string;
    website: string;
    email: string;
    phone: string;
    address: string;
  };
  logoAssetId: string | null;
  colors: {
    primary: string | null;
    secondary: string | null;
    accent: string | null;
  };
  typography: { headingFont: string; bodyFont: string };
}
export interface WorkspaceBrandProfile extends WorkspaceBrandData {
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}
