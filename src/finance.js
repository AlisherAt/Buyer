export function toNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

export function combinedTaxRate(settings = {}) {
  const paymentFeeRate = toNumber(settings.paymentFeeRate);
  const taxRate = toNumber(settings.taxRate);
  return paymentFeeRate + taxRate;
}

export function calcDeal(form, taxRate) {
  const salePrice = toNumber(form.salePrice ?? form.price);
  const rate = toNumber(form.rate);
  const buyForeign = toNumber(form.buyPrice ?? form.priceForeign);
  const deliveryForeign = toNumber(form.delivery ?? form.internationalDelivery);
  const buyKzt = buyForeign * rate;
  const deliveryKzt = deliveryForeign * rate;
  const tax = salePrice * toNumber(taxRate) / 100;
  const cost = buyKzt + deliveryKzt;
  return {
    salePrice,
    rate,
    buyForeign,
    deliveryForeign,
    buyKzt,
    deliveryKzt,
    tax,
    cost,
    profit: salePrice - tax - cost,
    taxRate: toNumber(taxRate)
  };
}

export function dealMetrics(sale, purchase, fallbackTaxRate) {
  if (sale?.profit != null && sale?.taxAmount != null && sale?.costAmount != null) {
    return {
      salePrice: toNumber(sale.price),
      tax: toNumber(sale.taxAmount),
      cost: toNumber(sale.costAmount),
      profit: toNumber(sale.profit),
      rate: toNumber(sale.rate ?? purchase?.rate)
    };
  }
  const calc = calcDeal({
    price: sale?.price,
    buyPrice: purchase?.price,
    delivery: purchase?.internationalDelivery,
    rate: sale?.rate || purchase?.rate
  }, sale?.taxRate ?? fallbackTaxRate);
  if (purchase?.totalCost && !toNumber(purchase.internationalDelivery) && !toNumber(purchase.price)) {
    calc.cost = toNumber(purchase.totalCost);
    calc.profit = calc.salePrice - calc.tax - calc.cost;
  } else if (purchase?.totalCost && !toNumber(sale?.rate) && !toNumber(purchase?.rate)) {
    calc.cost = toNumber(purchase.totalCost);
    calc.profit = calc.salePrice - calc.tax - calc.cost;
  }
  return calc;
}
