    // Every ACTIVE warehouse is listed for every size, even when it has no stock row for that size — a row
    // that is simply absent would otherwise look like "we don't know", when the truth is 0. Default warehouse
    // first, then alphabetical, so the table reads the same on every product page.
    const activeLocs = locations
      .filter((l) => l.active)
      .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || a.name.localeCompare(b.name))
    const variantIds = new Set(variants.map((v) => v._id as string))
    type Wh = { locationId: string; locationName: string; available: number; processing: number; inTransit: number; returning: number; active: boolean; isDefault: boolean }
    const byVariant = new Map<string, Map<string, Wh>>()
    const seed = (variantId: string) => {
      let m = byVariant.get(variantId)
      if (!m) {
        m = new Map()
        for (const l of activeLocs) {
          m.set(l._id as string, { locationId: l._id as string, locationName: l.name, available: 0, processing: 0, inTransit: 0, returning: 0, active: true, isDefault: !!l.isDefault })
        }
        byVariant.set(variantId, m)
      }
      return m
    }
    // Seed every size up front, so a size with no stock rows at all still lists each active warehouse at 0
    // (rather than rendering as "no warehouse rows", which reads as "unknown").
    for (const v of variants) seed(v._id as string)
    for (const r of await ctx.db.query("stock").collect()) {
      if (!variantIds.has(r.variantId as string)) continue
      const loc = locById.get(r.locationId as string)
      const m = seed(r.variantId as string)
      const row = m.get(r.locationId as string)
      if (row) {
        row.available = r.available
        row.processing = r.processing
        row.inTransit = r.inTransit
        row.returning = r.returning
      } else {
        // Stock sitting in a warehouse that has since been deactivated — keep it visible (flagged) rather
        // than silently dropping real inventory off the page.
        m.set(r.locationId as string, {
          locationId: r.locationId as string, locationName: loc?.name ?? "Warehouse",
          available: r.available, processing: r.processing, inTransit: r.inTransit, returning: r.returning,
          active: false, isDefault: !!loc?.isDefault,
        })
      }
    }
    return {
      _id: product._id,
      name: product.name,
      category: product.category ?? "",
      description: product.description ?? "",
      imageUrl: product.imageUrl,
      active: product.active,
      features: product.features ?? [],
      variants: variants
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
        .map((vr) => ({
          _id: vr._id,
          sku: vr.sku,
          title: vr.title,
          attrs: vr.attrs,
          price: vr.price,
          purchasePrice: vr.purchasePrice,
          active: vr.active,
          stock: stock.get(vr._id) ?? emptySum(),
          warehouses: [...(byVariant.get(vr._id as string)?.values() ?? [])]
            .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.active) - Number(a.active) || a.locationName.localeCompare(b.locationName)),
        })),
    }
  },
})
