import { Module } from "@nestjs/common";
import {
  PlatformStoresController,
  StoreApplicationController,
  StoreSettingsController,
} from "./stores.controller.js";
import { StoreApplicationService } from "./store-application.service.js";
import { StoreService } from "./store.service.js";
import { StaffService } from "./staff.service.js";

@Module({
  controllers: [StoreApplicationController, PlatformStoresController, StoreSettingsController],
  providers: [StoreApplicationService, StoreService, StaffService],
  exports: [StoreService, StaffService],
})
export class StoresModule {}
