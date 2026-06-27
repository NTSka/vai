# Access Control Domain Types

This document captures the first layer for future customizable roles and
permissions.

The current model defines the shape only; full authorization behavior and
permission evaluation rules are out of scope for now.

## Principles

- Roles may be system-level or organization-level.
- Organization owners should later be able to define and customize roles.
- Permission keys are intentionally lightweight for now.

## Identifiers

```ts
type OrganizationID = string;
type RoleID = string;
type PermissionKey = string;
```

## Role

```ts
interface Role {
  id: RoleID;

  organizationId?: OrganizationID;

  name: string;
  description?: string;

  scope: RoleScope;

  permissionKeys: PermissionKey[];

  system: boolean;

  createdAt: Date;
  updatedAt: Date;
}

type RoleScope =
  | "system"
  | "organization";
```

Suggested initial system roles:

```ts
const SYSTEM_ROLES = [
  "organization_owner",
  "organization_admin",
  "organization_member",
  "organization_viewer",
];
```

## Open Questions

- Should `PermissionKey` start as a flat string key, for example
  `document.upload`, or should it be resource-aware from the first
  implementation?
- Should system roles be stored as regular `Role` records or seeded from code?
