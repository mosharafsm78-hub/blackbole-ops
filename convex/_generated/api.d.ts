/* eslint-disable */
/**
 * Generated file. THIS CODE IS AUTOMATICALLY GENERATED.
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounting from "../accounting.js";
import type * as admin from "../admin.js";
import type * as ads from "../ads.js";
import type * as auth from "../auth.js";
import type * as catalog from "../catalog.js";
import type * as crons from "../crons.js";
import type * as customers from "../customers.js";
import type * as dashboard from "../dashboard.js";
import type * as discounts from "../discounts.js";
import type * as http from "../http.js";
import type * as lib from "../lib.js";
import type * as marketingFeed from "../marketingFeed.js";
import type * as migrate from "../migrate.js";
import type * as orders from "../orders.js";
import type * as outbound from "../outbound.js";
import type * as partners from "../partners.js";
import type * as pathao from "../pathao.js";
import type * as pathaoNode from "../pathaoNode.js";
import type * as publicApi from "../publicApi.js";
import type * as purchasing from "../purchasing.js";
import type * as reports from "../reports.js";
import type * as rules from "../rules.js";
import type * as settings from "../settings.js";
import type * as shopify from "../shopify.js";
import type * as team from "../team.js";
import type * as website from "../website.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";

declare const fullApi: ApiFromModules<{
  accounting: typeof accounting;
  admin: typeof admin;
  ads: typeof ads;
  auth: typeof auth;
  catalog: typeof catalog;
  crons: typeof crons;
  customers: typeof customers;
  dashboard: typeof dashboard;
  discounts: typeof discounts;
  http: typeof http;
  lib: typeof lib;
  marketingFeed: typeof marketingFeed;
  migrate: typeof migrate;
  orders: typeof orders;
  outbound: typeof outbound;
  partners: typeof partners;
  pathao: typeof pathao;
  pathaoNode: typeof pathaoNode;
  publicApi: typeof publicApi;
  purchasing: typeof purchasing;
  reports: typeof reports;
  rules: typeof rules;
  settings: typeof settings;
  shopify: typeof shopify;
  team: typeof team;
  website: typeof website;
}>;

export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
export declare const components: {};
