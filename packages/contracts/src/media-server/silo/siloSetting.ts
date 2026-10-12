import z from 'zod'
import { serviceUrlSchema } from '../../settings/serviceUrl'

/**
 * Schema for Silo server settings. Silo authenticates server-to-server
 * clients with an API key issued to an administrator account, so no user
 * selection is needed: watch history is read across every account.
 */
export const siloSettingSchema = z.object({
  silo_url: serviceUrlSchema,
  silo_api_key: z.string().trim().min(1, 'API key is required'),
})

export type SiloSetting = z.infer<typeof siloSettingSchema>
