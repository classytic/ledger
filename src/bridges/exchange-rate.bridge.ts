/**
 * Exchange Rate Bridge — host-injected rate sourcing.
 *
 * The ledger never hardcodes where exchange rates come from. The host
 * provides an implementation at engine init time:
 *
 *   - ManualRateBridge:        user-entered Currency Exchange records
 *   - BangladeshBankRateBridge: BB daily rate API
 *   - FixedRateBridge:         hardcoded for testing
 *   - ProviderRateBridge:      third-party rate API (Wise, Open Exchange Rates)
 *
 * When no bridge is provided, the caller must supply the exchange rate
 * explicitly on every journal item (the existing behavior). The bridge
 * is a convenience for hosts that want automatic rate lookup.
 *
 * @example
 * ```ts
 * const engine = createAccountingEngine({
 *   country: bdPack,
 *   currency: 'BDT',
 *   multiCurrency: { enabled: true, currencies: ['USD', 'EUR'] },
 *   bridges: {
 *     exchangeRate: {
 *       async getRate(from, to, date) {
 *         const row = await CurrencyExchange.findOne({ from, to, date });
 *         if (!row) throw new Error(`No rate for ${from}→${to} on ${date}`);
 *         return row.rate;
 *       },
 *     },
 *   },
 * });
 * ```
 */

export interface ExchangeRateBridge {
  /**
   * Get the exchange rate for converting `fromCurrency` to `toCurrency`
   * on a given date.
   *
   * @param fromCurrency ISO 4217 code (e.g., 'USD')
   * @param toCurrency   ISO 4217 code (e.g., 'BDT')
   * @param date         Transaction date (rate as of this date)
   * @param purpose      Optional: 'buying' or 'selling' rate (some central
   *                     banks publish separate rates)
   * @returns The rate as a positive decimal. Example: 120.50 means
   *          1 USD = 120.50 BDT.
   * @throws When no rate is available for the requested pair + date.
   */
  getRate(
    fromCurrency: string,
    toCurrency: string,
    date: Date,
    purpose?: 'buying' | 'selling',
  ): Promise<number>;

  /**
   * Optional batch lookup — avoids N+1 when posting multi-line entries
   * with different currencies. Host implementations that cache rates
   * benefit from a single DB round-trip.
   *
   * When absent, the engine falls back to calling `getRate()` per item.
   */
  getRates?(
    requests: Array<{
      fromCurrency: string;
      toCurrency: string;
      date: Date;
      purpose?: 'buying' | 'selling';
    }>,
  ): Promise<Map<string, number>>;
}
