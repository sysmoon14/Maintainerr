import { Trans, useLingui } from '@lingui/react/macro'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  type SiloSetting,
  siloSettingSchema,
  stripTrailingSlashes,
} from '@maintainerr/contracts'
import { useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { useSettingsOutletContext } from '..'
import {
  useDeleteSiloSettings,
  useSaveSiloSettings,
  useSiloSettings,
  useTestSilo,
} from '../../../api/settings'
import { getApiErrorMessage } from '../../../utils/ApiError'
import SaveButton from '../../Common/SaveButton'
import TestingButton from '../../Common/TestingButton'
import { InputGroup } from '../../Forms/Input'
import { ServiceApiKeyHelp } from '../../Forms/ServiceApiKeyHelp'
import { ServiceBasePathInput } from '../../Forms/ServiceBasePathInput'
import { ServiceUrlExamples } from '../../Forms/ServiceUrlExamples'
import ServiceCard, { ServiceCardFooter } from '../ServiceCard'
import { useSettingsFeedback } from '../useSettingsFeedback'

const SiloSettingDeleteSchema = z.object({
  silo_url: z.literal(''),
  silo_api_key: z.literal(''),
})

const SiloSettingFormSchema = z.union([
  siloSettingSchema,
  SiloSettingDeleteSchema,
])

type SiloSettingFormResult = z.infer<typeof SiloSettingFormSchema>

const SiloSettings = () => {
  const { t } = useLingui()
  const [testResult, setTestResult] = useState<{
    status: boolean
    message: string
  } | null>(null)
  const [testedSettings, setTestedSettings] = useState<{
    url: string
    apiKey: string
  } | null>(null)
  const { feedback, showUpdated, showError, clear } = useSettingsFeedback({
    updated: t`Saved`,
    updateError: t`Silo settings could not be updated`,
  })

  const { settings } = useSettingsOutletContext()

  const { data: siloData } = useSiloSettings({ enabled: !!settings })
  const isSiloLoading = settings != null && siloData == null

  // Sync the form to the loaded settings once they arrive. react-hook-form's
  // `values` option deep-compares, so an unstable reference with equal contents
  // won't re-trigger a reset.
  const formValues = siloData
    ? {
        silo_url: siloData.silo_url ?? '',
        silo_api_key: siloData.silo_api_key ?? '',
      }
    : undefined

  const { mutateAsync: testSilo, isPending: isTestPending } = useTestSilo()
  const { mutateAsync: saveSettings, isPending: isSavePending } =
    useSaveSiloSettings()
  const { mutateAsync: deleteSettings, isPending: isDeletePending } =
    useDeleteSiloSettings()

  const {
    register,
    handleSubmit,
    trigger,
    control,
    setValue,
    reset,
    formState: { errors },
  } = useForm<SiloSettingFormResult, any, SiloSettingFormResult>({
    resolver: zodResolver(SiloSettingFormSchema),
    defaultValues: { silo_url: '', silo_api_key: '' },
    values: formValues,
  })

  const siloUrl = useWatch({ control, name: 'silo_url' })
  const siloApiKey = useWatch({ control, name: 'silo_api_key' })

  const isGoingToRemoveSettings = siloUrl === '' && siloApiKey === ''
  const enteredSettingsHaveBeenTested =
    siloUrl === testedSettings?.url &&
    siloApiKey === testedSettings?.apiKey &&
    testResult?.status
  const canSaveSettings =
    !isSiloLoading && !isTestPending && !isSavePending && !isDeletePending

  const clearTransientState = () => {
    clear()
    setTestResult(null)
    setTestedSettings(null)
  }

  const registerApiKey = register('silo_api_key', {
    onChange: () => {
      clearTransientState()
    },
  })

  const handleTest = async () => {
    if (isTestPending || !(await trigger())) return

    // The status shows whatever happened last, so a new test hides "Saved".
    clear()
    setTestResult(null)

    try {
      const result = await testSilo({
        silo_url: siloUrl,
        silo_api_key: siloApiKey,
      })

      if (result.code === 1) {
        setTestResult({ status: true, message: t`Success!` })
        setTestedSettings({ url: siloUrl, apiKey: siloApiKey })
      } else {
        setTestResult({ status: false, message: result.message })
        setTestedSettings(null)
      }
    } catch (error) {
      const message = getApiErrorMessage(
        error,
        t`Failed to connect to Silo. Verify URL and API key.`,
      )
      setTestResult({ status: false, message })
      setTestedSettings(null)
    }
  }

  const onSubmit = async (data: SiloSettingFormResult) => {
    clear()

    if (data.silo_url === '' && data.silo_api_key === '') {
      try {
        await deleteSettings()
        reset({ silo_url: '', silo_api_key: '' })
        setTestResult(null)
        setTestedSettings(null)
        showUpdated()
      } catch (error) {
        showError(
          getApiErrorMessage(error, t`Silo settings could not be updated`),
        )
      }
      return
    }

    try {
      await saveSettings(data as SiloSetting)
      reset(data)
      showUpdated()
    } catch (error) {
      showError(
        getApiErrorMessage(error, t`Silo settings could not be updated`),
      )
    }
  }

  return (
    <>
      <title>{t`Silo settings - Maintainerr`}</title>
      <div className="max-w-6xl">
        <ServiceCard title="Silo">
          <form
            className="flex flex-1 flex-col gap-3"
            onSubmit={handleSubmit(onSubmit)}
          >
            <Controller
              name="silo_url"
              control={control}
              render={({ field }) => (
                <InputGroup
                  layout="stacked"
                  label={t`Silo URL`}
                  value={field.value}
                  placeholder="http://silo.local:8080"
                  helpText={
                    <ServiceUrlExamples
                      examples={[
                        'http://localhost:8080',
                        'https://silo.example.com',
                      ]}
                    />
                  }
                  onChange={(event) => {
                    clearTransientState()
                    field.onChange(event)
                  }}
                  onBlur={(event) =>
                    field.onChange(stripTrailingSlashes(event.target.value))
                  }
                  ref={field.ref}
                  name={field.name}
                  type="text"
                  error={errors.silo_url?.message}
                  required
                />
              )}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ServiceBasePathInput
                name="silo_url"
                value={siloUrl ?? ''}
                onChange={(value) => {
                  clearTransientState()
                  setValue('silo_url', value, { shouldDirty: true })
                }}
              />
              <InputGroup
                layout="stacked"
                label={t`API Key`}
                type="password"
                {...registerApiKey}
                error={errors.silo_api_key?.message}
                helpText={
                  <ServiceApiKeyHelp url={siloUrl} path="/admin/api-keys">
                    <Trans>
                      Find it here: Admin → API Keys. The key must belong to an
                      administrator.
                    </Trans>
                  </ServiceApiKeyHelp>
                }
              />
            </div>

            <ServiceCardFooter
              status={
                feedback ??
                (testResult
                  ? {
                      type: testResult.status ? 'success' : 'error',
                      title: testResult.message,
                    }
                  : null)
              }
            >
              <TestingButton
                type="button"
                buttonType="success"
                onClick={handleTest}
                disabled={
                  isSiloLoading || isTestPending || isGoingToRemoveSettings
                }
                isPending={isTestPending}
                feedbackStatus={
                  enteredSettingsHaveBeenTested ? testResult?.status : undefined
                }
              />
              <SaveButton
                type="submit"
                disabled={!canSaveSettings}
                isPending={isSavePending || isDeletePending}
              />
            </ServiceCardFooter>
          </form>
        </ServiceCard>
      </div>
    </>
  )
}

export default SiloSettings
