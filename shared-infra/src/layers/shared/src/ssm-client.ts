import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const client = new SSMClient({});
const cache = new Map<string, string>();

export async function getParam(name: string, decrypt = false): Promise<string> {
  if (cache.has(name)) return cache.get(name)!;
  const { Parameter } = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: decrypt })
  );
  if (!Parameter?.Value) throw new Error(`SSM param not found: ${name}`);
  cache.set(name, Parameter.Value);
  return Parameter.Value;
}
