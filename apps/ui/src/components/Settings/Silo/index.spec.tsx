import { fireEvent, render, screen, waitFor } from '../../../test-utils/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SiloSettings from './index'

const saveSettingsMock = vi.fn()
const testMock = vi.fn()
const showUpdated = vi.fn()
const showError = vi.fn()
const clear = vi.fn()

vi.mock('..', () => ({
  useSettingsOutletContext: () => ({ settings: {} }),
}))

vi.mock('../../../api/settings', () => ({
  useSiloSettings: () => ({
    data: { silo_url: 'http://silo.local:8080', silo_api_key: 'sa_saved' },
  }),
  useTestSilo: () => ({ mutateAsync: testMock, isPending: false }),
  useSaveSiloSettings: () => ({
    mutateAsync: saveSettingsMock,
    isPending: false,
  }),
  useDeleteSiloSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('../useSettingsFeedback', () => ({
  useSettingsFeedback: () => ({
    feedback: null,
    showUpdated,
    showError,
    clear,
  }),
}))

describe('SiloSettings', () => {
  beforeEach(() => {
    saveSettingsMock.mockReset()
    testMock.mockReset()
    showUpdated.mockReset()
    showError.mockReset()
    clear.mockReset()
  })

  it('surfaces a refused save instead of reporting success', async () => {
    saveSettingsMock.mockRejectedValue(
      new Error('The Silo API key must belong to an administrator account'),
    )

    render(<SiloSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith(
        'The Silo API key must belong to an administrator account',
      )
    })
    expect(showUpdated).not.toHaveBeenCalled()
  })

  it('shows why a connection test failed', async () => {
    testMock.mockResolvedValue({
      code: 0,
      message: 'The Silo API key must belong to an administrator account',
    })

    render(<SiloSettings />)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Test Connection' }),
    )

    expect(
      await screen.findByText(
        'The Silo API key must belong to an administrator account',
      ),
    ).toBeTruthy()
  })
})
