import { z } from "zod";
import { WRITE_POLICIES } from "../core/types.js";

export const ProfileSchema = z
  .object({
    url: z.string().url().optional(),
    deployment: z.string().min(1).optional(),
    adminKey: z.string().min(1).optional(),
    adminKeyEnv: z.string().min(1).optional(),
    deployKey: z.string().min(1).optional(),
    deployKeyEnv: z.string().min(1).optional(),
    projectDir: z.string().min(1).optional(),
    writePolicy: z.enum(WRITE_POLICIES).default("require-allow-write"),
  })
  .superRefine((profile, ctx) => {
    if (profile.url && profile.deployment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose either url (self-hosted) or deployment (Convex Cloud), not both.",
      });
    }
    if (!profile.url && !profile.deployment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Profile needs either url (self-hosted) or deployment (Convex cloud reference).",
      });
    }
    if (profile.url && !profile.adminKey && !profile.adminKeyEnv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Self-hosted URL profiles need adminKey or adminKeyEnv.",
      });
    }
    if (profile.url && (profile.deployKey || profile.deployKeyEnv)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cloud deploy keys can only be used with a deployment profile.",
      });
    }
    if (!profile.deployment && (profile.deployKey || profile.deployKeyEnv)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cloud deploy keys require a deployment reference.",
      });
    }
  });

export type Profile = z.input<typeof ProfileSchema>;

export const DASHBOARD_RELEASE_TAG = /^precompiled-\d{4}-\d{2}-\d{2}-[0-9a-f]{7,40}$/;

export const ConfigSchema = z.object({
  defaultProfile: z.string().min(1).optional(),
  dashboardVersion: z.string().regex(DASHBOARD_RELEASE_TAG).optional(),
  profiles: z.record(z.string(), ProfileSchema),
});

export type Config = z.input<typeof ConfigSchema>;
