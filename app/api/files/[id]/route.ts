import { AuthError, authErrorResponse, requireSession } from '@/lib/auth';
import { getBindings } from '@/lib/runtime';
import { ownFile, liveFileBytes, validateDemoFile } from '@/lib/mentor-data/files';
import { loadDemo } from '@/lib/mentor-data/store';
import { requireMentor } from '@/lib/mentor-data/validation';
import { errorEnvelope, fail, safeError } from '@/lib/mentor-data/errors';

export const dynamic = 'force-dynamic';
export async function GET(request:Request,context:{params:Promise<{id:string}>}):Promise<Response> {
  try {
    const principal=await requireSession(request),bindings=getBindings(),mode=bindings.PORTAL_MODE==='demo'?'demo':'live';requireMentor(principal,mode);
    const {id}=await context.params; if(!/^file_[A-Za-z0-9_-]{1,100}$/.test(id)) fail('RECORD_NOT_FOUND','This attachment is unavailable.',404);
    const file=await ownFile(bindings.DB,principal,id);
    let body:BodyInit,mime=file.mime_type,name=file.file_name,size=file.size_bytes;
    if(mode==='demo') {validateDemoFile((await loadDemo(bindings.DB,principal)).state,file); const object=await bindings.BUCKET.get(file.object_key);if(!object || object.size!==file.size_bytes)fail('RECORD_NOT_FOUND','This attachment is unavailable.',404);body=object.body as unknown as BodyInit;}
    else {const download=await liveFileBytes(bindings,principal,file);body=download.bytes as unknown as BodyInit;mime=download.mimeType as typeof mime;name=download.fileName;size=download.bytes.length;}
    return new Response(body,{headers:{'Content-Type':mime,'Content-Length':String(size),'Content-Disposition':`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
  }catch(error){if(error instanceof AuthError)return authErrorResponse(error);const safe=safeError(error);return Response.json(errorEnvelope(crypto.randomUUID(),safe),{status:safe.status,headers:{'Cache-Control':'no-store'}});}
}
