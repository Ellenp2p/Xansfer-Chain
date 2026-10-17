import { afterEach, describe, expect, it, vi } from 'vitest'
import { keccak256 } from 'viem'
import { isAttestationReady, queryIris } from './iris'

const TX_HASH = '0x' + 'ab'.repeat(32)
const MESSAGE_SENT_TOPIC = keccak256(new TextEncoder().encode('MessageSent(bytes)'))

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

function abiWord(value: number): string {
  return value.toString(16).padStart(64, '0')
}

describe('isAttestationReady', () => {
  it('treats pending/empty values as not ready', () => {
    expect(isAttestationReady(null)).toBe(false)
    expect(isAttestationReady('')).toBe(false)
    expect(isAttestationReady('PENDING')).toBe(false)
    expect(isAttestationReady('0x1234')).toBe(true)
  })
})

describe('queryIris v2', () => {
  it('queries the domain endpoint and maps the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        messages: [
          {
            message: '0xdeadbeef',
            eventNonce: '1',
            attestation: 'PENDING',
            cctpVersion: 2,
            status: 'pending',
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await queryIris(6, TX_HASH, 2, 'testnet')
    expect(fetchMock).toHaveBeenCalledWith(
      `https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=${TX_HASH}`,
    )
    expect(result).toMatchObject({
      message: '0xdeadbeef',
      event_nonce: '1',
      attestation: 'PENDING',
      cctp_version: 2,
      status: 'pending',
    })
  })

  it('returns null for HTTP errors and empty message lists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 500)))
    await expect(queryIris(6, TX_HASH, 2, 'testnet')).resolves.toBeNull()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ messages: [] })))
    await expect(queryIris(6, TX_HASH, 2, 'testnet')).resolves.toBeNull()
  })
})

describe('queryIris v1', () => {
  it('extracts the message from an EVM MessageSent log', async () => {
    const message = '0xdeadbeef'
    const logData = '0x' + abiWord(32) + abiWord(4) + 'deadbeef'.padEnd(64, '0')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        result: { logs: [{ topics: [MESSAGE_SENT_TOPIC], data: logData }] },
      }))
      .mockResolvedValueOnce(jsonResponse({ status: 'complete', attestation: '0x1234' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await queryIris(0, TX_HASH, 1, 'testnet')
    expect(result?.message).toBe(message)
    expect(result?.attestation).toBe('0x1234')
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://iris-api-sandbox.circle.com/attestations/${keccak256(message)}`,
    )
  })

  it('extracts the message from an Aptos MessageSent event', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        events: [{
          type: '0x1::message_transmitter::MessageSent',
          data: { message: 'deadbeef' },
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ status: 'complete', attestation: '0x5678' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await queryIris(9, TX_HASH, 1, 'testnet')
    expect(result?.message).toBe('0xdeadbeef')
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://fullnode.testnet.aptoslabs.com/v1/transactions/by_hash/${TX_HASH}`,
    )
  })

  it('extracts the message from a Sui MessageSent event', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          transaction: {
            effects: {
              events: {
                nodes: [{
                  type: { repr: '0x2::message_transmitter::MessageSent' },
                  contents: { json: { message: [222, 173, 190, 239] } },
                }],
              },
            },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ status: 'complete', attestation: '0x9abc' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await queryIris(8, TX_HASH, 1, 'testnet')
    expect(result?.message).toBe('0xdeadbeef')
    expect(fetchMock.mock.calls[0][0]).toBe('https://graphql.testnet.sui.io/graphql')
  })

  it('returns null when the source transaction has no MessageSent event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ result: { logs: [] } })))
    await expect(queryIris(0, TX_HASH, 1, 'testnet')).resolves.toBeNull()
  })
})
