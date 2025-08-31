# Stock Scripts

## YieldMax ETF Analyzer
Analyzes all YieldMax ETFs and filters by recent rising performance.

### Details

For short term calculations:
- If dividend payout is weekly, uses the last 5 weeks of data.
- If dividend payout is monthly, uses the last 2 months of data.

For medium term calculations:
- If dividend payout is weekly, uses the last 8 weeks of data.
- If dividend payout is monthly, uses the last 3 months of data.

For entry point calculations:
- If dividend payout is weekly, uses the last 2 weeks of data.
  - This allows us to see some weekly ETFs as the previous criteria was too strict.
- If dividend payout is monthly, uses the last 2 months of data.

The script only looks for increasing payouts during these ranges, indicating current growth and potential for continued growth.

### View the Code and Results

See the script [here](https://github.com/nishant/stock-scripts/blob/master/src/yieldmax%20analyzer/yieldmax-etf-analyzer.ts)<br>
See the results [here](https://github.com/nishant/stock-scripts/blob/master/src/yieldmax%20analyzer/output.md)

