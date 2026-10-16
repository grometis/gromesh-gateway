import { Module } from "@nestjs/common";
import { PluginCatalogModule } from "../plugin-catalog/catalog.js";
import { AtRestService } from "./at-rest.js";

@Module({ imports: [PluginCatalogModule], providers: [AtRestService], exports: [AtRestService] })
export class AtRestModule {}
