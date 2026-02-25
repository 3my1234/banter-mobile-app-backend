import axios from 'axios';

export type FlutterwavePaymentData = {
  email: string;
  amount: number;
  currency: string;
  tx_ref: string;
  payment_options?: string;
  customer: {
    email: string;
    name: string;
    phonenumber?: string;
  };
  customizations?: {
    title?: string;
    description?: string;
    logo?: string;
  };
  redirect_url: string;
};

export type FlutterwaveResponse = {
  status: string;
  message: string;
  data: {
    link: string;
    [key: string]: any;
  };
};

export type FlutterwaveVerificationResponse = {
  status: string;
  message: string;
  data: {
    status: string;
    amount: number;
    currency: string;
    tx_ref: string;
    [key: string]: any;
  };
};

const baseURL = 'https://api.flutterwave.com/v3';

const getSecretKey = () => {
  const secret = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!secret) {
    throw new Error('Flutterwave secret key is not configured');
  }
  return secret;
};

export async function initializeFlutterwavePayment(
  paymentData: FlutterwavePaymentData
): Promise<FlutterwaveResponse> {
  const secretKey = getSecretKey();
  const response = await axios.post(`${baseURL}/payments`, paymentData, {
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
  });
  return response.data as FlutterwaveResponse;
}

export async function verifyFlutterwavePayment(
  transactionId: string
): Promise<FlutterwaveVerificationResponse> {
  const secretKey = getSecretKey();
  const response = await axios.get(`${baseURL}/transactions/${transactionId}/verify`, {
    headers: {
      Authorization: `Bearer ${secretKey}`,
    },
  });
  return response.data as FlutterwaveVerificationResponse;
}

export async function findFlutterwaveTransactionByRef(
  txRef: string
): Promise<string | null> {
  const secretKey = getSecretKey();
  const response = await axios.get(`${baseURL}/transactions`, {
    headers: {
      Authorization: `Bearer ${secretKey}`,
    },
    params: {
      tx_ref: txRef,
    },
  });

  const data = response.data?.data;
  if (Array.isArray(data) && data.length > 0) {
    const id = data[0]?.id;
    return id ? String(id) : null;
  }
  return null;
}
