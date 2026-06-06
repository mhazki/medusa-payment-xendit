import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import XenditProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [XenditProviderService],
})
