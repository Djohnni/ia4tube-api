"use strict";
const { createCalendarStore } = require("./store");
const { createCalendarSource } = require("./source");
const { createCalendarMedia } = require("./media");
const { createCalendarGrants } = require("./grants");
const { createCalendarPublisher } = require("./publisher");
const { createCalendarService } = require("./service");
async function createProductionCalendar(dependencies, ports) {
  const store = createCalendarStore({ pool: ports.pool, role: ports.role });
  await store.verify(); // Optional additive schema must be prepared separately; never migrate at startup.
  const source = createCalendarSource(dependencies);
  const media = createCalendarMedia({ ...dependencies, publicOrigin: ports.config.publicOrigin, loadSource: source.load });
  let grants;
  try {
    grants = createCalendarGrants(dependencies.secret);
    const publisher = createCalendarPublisher({ ...ports, media });
    return createCalendarService({ ...dependencies, ...ports, store, source, media, grants, publisher });
  } catch (error) {
    grants?.close();
    media.close();
    throw error;
  }
}
module.exports = { createProductionCalendar };
