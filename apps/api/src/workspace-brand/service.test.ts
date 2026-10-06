import "../load-env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { createDbClient, schema } from "@opensuite/db";
import { eq } from "drizzle-orm";
import { createMemoryObjectStorage } from "../storage/index.js";
import { createWorkspaceService } from "../workspaces/service.js";
import { createStorageAccountingService } from "../storage-accounting/service.js";
import { createWorkspaceAssetService } from "./assets.js";
import { createWorkspaceBrandService } from "./service.js";
import { registerWorkspaceBrandRoutes } from "../routes/workspace-brand.js";
import { assetMaxBytes, workspaceBrandSchema } from "./validation.js";
import sharp from "sharp";
import { optimizeWorkspaceImage } from "./images.js";
import type { WorkspaceBrandData } from "@opensuite/contracts";

const data: WorkspaceBrandData = {
  schemaVersion: 1,
  organization: {
    name: "Acme",
    website: "",
    email: "",
    phone: "",
    address: "",
  },
  logoAssetId: null,
  colors: { primary: "#ab12ef", secondary: null, accent: null },
  typography: { headingFont: "Arial", bodyFont: "Calibri" },
};
const png = await sharp({
  create: { width: 24, height: 12, channels: 4, background: { r: 20, g: 60, b: 100, alpha: 0.5 } },
})
  .png()
  .toBuffer();
const optimizedPng = await optimizeWorkspaceImage(png);

test("brand validation normalizes colors and rejects invalid settings", () => {
  assert.equal(workspaceBrandSchema.parse(data).colors.primary, "#AB12EF");
  for (const invalid of [
    { ...data, schemaVersion: 2 },
    { ...data, organization: { ...data.organization, name: " " } },
    { ...data, colors: { ...data.colors, primary: "#abc" } },
    {
      ...data,
      organization: { ...data.organization, website: "javascript:alert(1)" },
    },
    { ...data, organization: { ...data.organization, email: "bad" } },
  ])
    assert.equal(workspaceBrandSchema.safeParse(invalid).success, false);
});

test(
  "brand save/load, authorization, logo ownership, cleanup, quota and workspace purge",
  { skip: process.env.RUN_BRAND_DB_TESTS !== "true" },
  async () => {
    assert.ok(process.env.DATABASE_URL);
    const admin = createDbClient({ databaseUrl: process.env.DATABASE_URL });
    const testSchema = `brand_test_${randomUUID().replaceAll("-", "")}`;
    const quoted = `"${testSchema}"`;
    await admin.pool.query(`CREATE SCHEMA ${quoted}`);
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${testSchema}`);
    const client = createDbClient({ databaseUrl: url.toString() });
    const app = Fastify();
    try {
      const folder = new URL("../../../../packages/db/migrations/", import.meta.url);
      const journal = JSON.parse(await readFile(new URL("meta/_journal.json", folder), "utf8")) as {
        entries: { tag: string }[];
      };
      for (const { tag } of journal.entries)
        await client.pool.query(
          (await readFile(new URL(`${tag}.sql`, folder), "utf8")).replaceAll('"public"', quoted),
        );
      const alice = `alice-${randomUUID()}`,
        bob = `bob-${randomUUID()}`;
      await client.db.insert(schema.user).values(
        [alice, bob].map((id) => ({
          id,
          name: id,
          email: `${id}@example.com`,
        })),
      );
      const [workspace, other] = await client.db
        .insert(schema.workspace)
        .values([
          { ownerUserId: alice, name: "Brand test" },
          { ownerUserId: bob, name: "Other" },
        ])
        .returning();
      assert.ok(workspace && other);
      const storage = createMemoryObjectStorage();
      const accounting = createStorageAccountingService(client.db, 10 * 1024 * 1024);
      const workspaces = createWorkspaceService(client.db, storage, accounting);
      const assets = createWorkspaceAssetService(client.db, storage, workspaces, accounting);
      const brand = createWorkspaceBrandService(client.db, assets);
      await app.register(multipart);
      registerWorkspaceBrandRoutes(
        app,
        {
          api: {
            getSession: async ({ headers }) => {
              const id = headers.get("x-test-user");
              return id === alice || id === bob
                ? {
                    user: { id, name: id, email: `${id}@example.com` },
                    session: {},
                  }
                : null;
            },
          },
        },
        brand,
        assets,
      );
      const path = `/api/workspaces/${workspace.id}/brand`;
      const headers = { "x-test-user": alice };
      assert.equal((await app.inject({ url: path })).statusCode, 401);
      assert.equal((await app.inject({ url: path, headers })).json().profile, null);
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: path,
            headers,
            payload: { ...data, schemaVersion: 2 },
          })
        ).statusCode,
        400,
      );
      const saved = await app.inject({
        method: "PUT",
        url: path,
        headers,
        payload: data,
      });
      assert.equal(saved.statusCode, 200, saved.body);
      const freshBrand = createWorkspaceBrandService(client.db, assets);
      assert.deepEqual(await freshBrand.get(workspace.id, alice), saved.json().profile);
      await client.db
        .update(schema.workspaceBrand)
        .set({
          data: {
            ...data,
            document: {
              headerText: "Old header",
              footerText: "Old footer",
              showLogo: true,
              showOrganizationName: true,
              showPageNumbers: true,
            },
          },
        })
        .where(eq(schema.workspaceBrand.workspaceId, workspace.id));
      const legacy = (await app.inject({ url: path, headers })).json().profile;
      assert.equal(Object.hasOwn(legacy, "document"), false);
      assert.equal(legacy.organization.name, "Acme");
      await brand.save(workspace.id, alice, data);
      for (const method of ["GET", "PUT"] as const)
        assert.equal(
          (
            await app.inject({
              method,
              url: path,
              headers: { "x-test-user": bob },
              ...(method === "PUT" ? { payload: data } : {}),
            })
          ).statusCode,
          404,
        );
      const logo = await sharp({
        create: {
          width: 3200,
          height: 800,
          channels: 4,
          background: { r: 24, g: 64, b: 128, alpha: 0.5 },
        },
      })
        .png({ compressionLevel: 1 })
        .toBuffer();
      const optimizedLogo = await optimizeWorkspaceImage(logo);
      const uploadPath = `/api/workspaces/${workspace.id}/assets`;
      const uploadBody = Buffer.concat([
        Buffer.from(
          '--brand\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n',
        ),
        logo,
        Buffer.from("\r\n--brand--\r\n"),
      ]);
      const uploaded = await app.inject({
        method: "POST",
        url: uploadPath,
        headers: {
          ...headers,
          "content-type": "multipart/form-data; boundary=brand",
        },
        payload: uploadBody,
      });
      assert.equal(uploaded.statusCode, 201, uploaded.body);
      const id = uploaded.json().asset.id;
      const imagePath = `${uploadPath}/${id}`;
      assert.deepEqual(
        (await app.inject({ url: imagePath, headers })).rawPayload,
        optimizedLogo.bytes,
      );
      const storedAsset = await assets.requireAsset(workspace.id, id);
      assert.equal(storedAsset.width, 2000);
      assert.equal(storedAsset.height, 500);
      assert.equal(storedAsset.originalSizeBytes, logo.length);
      assert.equal(storedAsset.sizeBytes, optimizedLogo.bytes.length);
      const foreign = await assets.upload(other.id, bob, png);
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: path,
            headers,
            payload: { ...data, logoAssetId: foreign.id },
          })
        ).statusCode,
        404,
      );
      for (const method of ["GET", "DELETE"] as const) {
        assert.equal(
          (
            await app.inject({
              method,
              url: imagePath,
              headers: { "x-test-user": bob },
            })
          ).statusCode,
          404,
        );
        assert.equal(
          (
            await app.inject({
              method,
              url: `/api/workspaces/${workspace.id}/assets/${foreign.id}`,
              headers,
            })
          ).statusCode,
          404,
        );
      }
      await brand.save(workspace.id, alice, { ...data, logoAssetId: id });
      await assets.removeUnused(workspace.id, alice, id); // Referenced images cannot be deleted.
      assert.equal(storage.objects.size, 2);
      const replacement = await assets.upload(workspace.id, alice, png);
      await brand.save(workspace.id, alice, {
        ...data,
        logoAssetId: replacement.id,
      });
      assert.equal((await app.inject({ url: imagePath, headers })).statusCode, 404);
      assert.equal((await accounting.status(alice)).usedBytes, optimizedPng.bytes.length);
      assert.equal((await accounting.reconcile(alice)).matches, true);
      await brand.save(workspace.id, alice, data);
      assert.equal((await accounting.status(alice)).usedBytes, 0);
      await assert.rejects(
        () => assets.upload(workspace.id, alice, Buffer.alloc(assetMaxBytes + 1)),
        /image/,
      );
      await assert.rejects(
        () => assets.upload(workspace.id, alice, Buffer.from("<svg/>")),
        /image/,
      );
      const quotaAssets = createWorkspaceAssetService(
        client.db,
        storage,
        workspaces,
        createStorageAccountingService(client.db, 1),
      );
      await assert.rejects(() => quotaAssets.upload(workspace.id, alice, png), /quota/);
      assert.equal(storage.objects.size, 1, "Failed upload cleans its object");
      const last = await assets.upload(workspace.id, alice, png);
      await brand.save(workspace.id, alice, { ...data, logoAssetId: last.id });
      await workspaces.softDelete({
        workspaceId: workspace.id,
        ownerUserId: alice,
      });
      assert.equal((await app.inject({ url: path, headers })).statusCode, 404);
      await workspaces.purge({ workspaceId: workspace.id, ownerUserId: alice });
      assert.equal((await accounting.status(alice)).usedBytes, 0);
      assert.equal(storage.objects.size, 1, "Other workspace image remains");
      assert.equal(
        (
          await client.db
            .select()
            .from(schema.workspaceBrand)
            .where(eq(schema.workspaceBrand.workspaceId, workspace.id))
        ).length,
        0,
      );
    } finally {
      await app.close();
      await client.close();
      await admin.pool.query(`DROP SCHEMA ${quoted} CASCADE`);
      await admin.close();
    }
  },
);
