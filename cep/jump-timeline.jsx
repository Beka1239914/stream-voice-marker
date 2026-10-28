/* Preserve native clip effects by cloning and cutting a sequence, not rebuilding media. */
$._SVMJumpLayout = function(parts, ranges) {
    var spans=[], cursor=0, content=0, previousRange=-1, previousEnd=-1;
    for(var i=0;i<parts.length;i++) {
        var p=parts[i], ri=p.range_index, range=ranges[ri];
        if(!range||ri<previousRange||p.start_frame<range.start_frame||p.end_frame>range.end_frame||p.end_frame<=p.start_frame)throw new Error('Неверные границы плана.');
        var a=range.timeline_start_frame+p.start_frame-range.start_frame,b=a+p.end_frame-p.start_frame;
        if(!isFinite(a)||!isFinite(b)||a!==Math.floor(a)||b!==Math.floor(b)||a<previousEnd)throw new Error('Неверный порядок фрагментов.');
        // Compact within each original clip, never join independent selected clips.
        if(ri!==previousRange)cursor=range.timeline_start_frame;
        spans.push({a:a,b:b,dest:cursor});cursor+=b-a;content+=b-a;
        previousRange=ri;previousEnd=b;
    }
    return {spans:spans,frames:cursor,content:content};
};
$._SVMJump = (function () {
    var state = null, TPS = 254016000000;
    function reply(x) { return JSON.stringify(x); }
    function fail(e) { return reply({error:String(e)}); }
    function tracks(s) {
        var r=[], t;
        for(t=0;t<s.videoTracks.numTracks;t++)r.push({track:s.videoTracks[t],kind:'Video',index:t});
        for(t=0;t<s.audioTracks.numTracks;t++)r.push({track:s.audioTracks[t],kind:'Audio',index:t});
        return r;
    }
    function sequence(id) {
        for(var i=0;i<app.project.sequences.numSequences;i++)if(app.project.sequences[i].sequenceID===id)return app.project.sequences[i];
        throw new Error('Исходная последовательность не найдена.');
    }
    function fingerprint(s) {
        var ts=tracks(s),r=[s.timebase,s.frameSizeHorizontal,s.frameSizeVertical],i,j;
        for(i=0;i<ts.length;i++) {
            var t=ts[i].track;
            r.push([ts[i].kind,ts[i].index,t.isLocked(),t.isMuted()]);
            for(j=0;j<t.clips.numItems;j++) {
                var c=t.clips[j];
                r.push([String(c.nodeId),String(c.projectItem.nodeId),c.start.ticks,c.end.ticks,c.inPoint.ticks,c.outPoint.ticks,c.getSpeed(),c.isSpeedReversed(),c.disabled]);
            }
        }
        return JSON.stringify(r);
    }
    function checkTracks(s) {
        var ts=tracks(s);
        for(var i=0;i<ts.length;i++) {
            var t=ts[i].track;
            if(t.clips.numItems && t.isLocked())throw new Error('Разблокируйте дорожки перед Jump Cut.');
            if(t.transitions && t.transitions.numItems)throw new Error('Jump Cut с сохранением монтажа пока требует дорожки без переходов.');
        }
        if(s.captionTracks && s.captionTracks.numTracks)throw new Error('Сначала выполните Jump Cut, затем добавьте субтитры.');
    }
    function load(path) {
        var f=new File(path);f.encoding='UTF8';if(!f.open('r'))throw new Error('Результат недоступен.');
        var text=f.read();f.close();return JSON.parse(text);
    }
    return {
        capture:function(source) {
            var s=app.project.activeSequence;
            checkTracks(s);
            if(Math.abs(TPS/Number(s.timebase)-source.fps)/source.fps>.00001)throw new Error('Частота кадров последовательности должна совпадать с исходником.');
            source.sequence_id=s.sequenceID;source.sequence_name=s.name;
            source.project_id=app.project.documentID;
            source.sequence_fingerprint=fingerprint(s);
            return source;
        },
        begin:function(source,path,inPlace) {
            try {
                if(state)throw new Error('Сборка уже выполняется.');
                var original=sequence(source.sequence_id), p=load(path), i;
                if(source.project_id!==app.project.documentID)throw new Error('Проект изменился. Повторите расчёт.');
                checkTracks(original);
                if(fingerprint(original)!==source.sequence_fingerprint)throw new Error('Монтаж изменился после расчёта. Рассчитайте Jump Cut заново.');
                if(p.mode!=='jumpcut'||!p.parts||!p.parts.length||p.parts.length>20000||p.fps!==source.fps)throw new Error('Неверный план Jump Cut.');
                var file=new File(p.source);
                if(file.fsName.toLowerCase()!==new File(source.path).fsName.toLowerCase()||file.length!==p.source_size||Math.abs(file.modified.getTime()-p.source_mtime_ms)>2000)throw new Error('Исходник изменился. Повторите расчёт.');
                var layout=$._SVMJumpLayout(p.parts,source.ranges),spans=layout.spans,cursor=layout.frames,boundaries=[];
                for(i=0;i<spans.length;i++){boundaries.push(spans[i].a);boundaries.push(spans[i].b);}
                if(layout.content!==p.total_frames)throw new Error('Неверная длительность плана.');
                var blocks=[],lengths={};
                for(i=0;i<p.parts.length;i++){var bp=p.parts[i];lengths[bp.range_index]=(lengths[bp.range_index]||0)+bp.end_frame-bp.start_frame;}
                for(i=0;i<source.ranges.length;i++)if(lengths[i])blocks.push({start:source.ranges[i].timeline_start_frame,end:source.ranges[i].timeline_start_frame+lengths[i],index:i});
                if(inPlace) {
                    if(!app.project.activeSequence||app.project.activeSequence.sequenceID!==original.sequenceID)throw new Error('Откройте исходный эпизод перед применением.');
                    if(Number(original.zeroPoint)!==0)throw new Error('Для обработки внутри эпизода нужен начальный таймкод 00:00:00:00.');
                    var endFrame=Math.round(Number(original.end)/Number(original.timebase)),outside=0,combined=[];
                    for(i=0;i<source.ranges.length;i++) {
                        var range=source.ranges[i],ra=range.timeline_start_frame,rb=ra+range.end_frame-range.start_frame;
                        if(ra<outside)throw new Error('Выбранные участки перекрываются.');
                        if(ra>outside)combined.push({a:outside,b:ra,dest:outside,untouched:true});
                        boundaries.push(ra);boundaries.push(rb);outside=rb;
                    }
                    if(outside<endFrame)combined.push({a:outside,b:endFrame,dest:outside,untouched:true});
                    spans=spans.concat(combined);spans.sort(function(a,b){return a.a-b.a;});
                    cursor=0;for(i=0;i<spans.length;i++)cursor=Math.max(cursor,spans[i].dest+spans[i].b-spans[i].a);
                    boundaries.sort(function(a,b){return a-b;});
                }
                var ids={};for(i=0;i<app.project.sequences.numSequences;i++)ids[app.project.sequences[i].sequenceID]=true;
                var copy=inPlace?original:null;
                if(!inPlace){original.clone();
                for(i=0;i<app.project.sequences.numSequences;i++)if(!ids[app.project.sequences[i].sequenceID])copy=app.project.sequences[i];}
                if(!copy)throw new Error('Premiere не создал копию.');
                if(!inPlace)copy.name='Jump Cut — '+original.name+' — '+new Date().getTime();
                // Razor timecode is relative to sequence zero; normalize the copy only.
                if(!inPlace)copy.setZeroPoint('0');app.project.openSequence(copy.sequenceID);app.enableQE();
                var unique=[];for(i=0;i<boundaries.length;i++)if(!i||boundaries[i]!==boundaries[i-1])unique.push(boundaries[i]);
                state={seq:copy,original:original,project:app.project.documentID,spans:spans,boundaries:unique,index:0,
                    tracks:tracks(copy),trackIndex:0,expected:[],frames:cursor,fps:TPS/Number(copy.timebase),phase:'cut',groups:null,linkIndex:0,linked:0,inPlace:!!inPlace,edited:{},blocks:blocks};
                return reply({count:unique.length+state.tracks.length});
            }catch(e){return fail(e);}
        },
        step:function() {
            try {
                var s=state;
                if(!s||app.project.documentID!==s.project||app.project.activeSequence.sequenceID!==s.seq.sequenceID)throw new Error('Активная последовательность изменилась. Сборка остановлена.');
                var i,j,t,tc;
                if(s.phase==='cut') {
                    var q=qe.project.getActiveSequence(),stop=Math.min(s.index+8,s.boundaries.length),settings=s.seq.getSettings();
                    for(;s.index<stop;s.index++) {
                        var tm=new Time();tm.ticks=String(Math.round(s.boundaries[s.index]*Number(s.seq.timebase)));
                        tc=tm.getFormatted(settings.videoFrameRate,settings.videoDisplayFormat);
                        for(t=0;t<s.tracks.length;t++) {
                            var row=s.tracks[t],track=row.track,needs=false;
                            for(j=0;j<track.clips.numItems;j++)if(track.clips[j].start.seconds*s.fps<s.boundaries[s.index]-.1&&track.clips[j].end.seconds*s.fps>s.boundaries[s.index]+.1){needs=true;break;}
                            if(needs) {
                                if(row.kind==='Video')q.getVideoTrackAt(row.index).razor(tc);
                                else q.getAudioTrackAt(row.index).razor(tc);
                            }
                        }
                    }
                    if(s.index===s.boundaries.length)s.phase='compact';
                } else if(s.trackIndex<s.tracks.length) {
                    var tr=s.tracks[s.trackIndex].track,keep=[],drop=[];
                    for(i=0;i<tr.clips.numItems;i++) {
                        var c=tr.clips[i],a=Math.round(c.start.seconds*s.fps),b=Math.round(c.end.seconds*s.fps),span=null;
                        for(j=0;j<s.spans.length;j++) {
                            var r=s.spans[j];
                            if(a>=r.a && b<=r.b){span=r;break;}
                            if(a<r.b&&b>r.a)throw new Error('Premiere не разрезал клип на нужной границе. Копия оставлена для проверки.');
                        }
                        if(span){keep.push({clip:c,start:span.dest+a-span.a,end:span.dest+b-span.a,inp:c.inPoint.ticks,out:c.outPoint.ticks,components:c.components.numItems});if(!span.untouched)s.edited[String(c.nodeId)]=true;}
                        else drop.push(c);
                    }
                    for(i=drop.length-1;i>=0;i--)drop[i].remove(false,true);
                    for(i=0;i<keep.length;i++) {
                        var k=keep[i],delta=new Time();delta.ticks=String(Math.round(k.start*Number(s.seq.timebase)-Number(k.clip.start.ticks)));
                        if(Number(delta.ticks)!==0)k.clip.move(delta);
                    }
                    s.expected.push(keep);s.trackIndex++;
                }
                if(s.trackIndex===s.tracks.length) {
                    if(s.groups===null) {
                        var byTime={},all=[];s.groups=[];
                        for(t=0;t<s.tracks.length;t++)for(i=0;i<s.tracks[t].track.clips.numItems;i++) {
                            var item=s.tracks[t].track.clips[i],key=item.start.ticks+'_'+item.end.ticks;
                            item.setSelected(false,false);
                            if(s.inPlace&&!s.edited[String(item.nodeId)])continue;
                            if(!byTime[key])byTime[key]=[];
                            byTime[key].push(item);all.push(item);item.setSelected(true,false);
                        }
                        // Remove inherited links that may still cross cut boundaries.
                        if(all.length)s.seq.unlinkSelection();
                        for(i=0;i<all.length;i++)all[i].setSelected(false,false);
                        for(var key in byTime)if(byTime.hasOwnProperty(key)&&byTime[key].length>1)s.groups.push(byTime[key]);
                    }
                    var linkStop=Math.min(s.linkIndex+10,s.groups.length);
                    for(;s.linkIndex<linkStop;s.linkIndex++) {
                        var group=s.groups[s.linkIndex];
                        for(i=0;i<group.length;i++)group[i].setSelected(true,false);
                        s.seq.linkSelection();
                        for(i=0;i<group.length;i++) {
                            var linked=group[i].getLinkedItems();
                            if(!linked||linked.numItems!==group.length)throw new Error('Не удалось связать видео и звук фрагмента. Копия оставлена для проверки.');
                            for(j=0;j<linked.numItems;j++)if(linked[j].start.ticks!==group[i].start.ticks||linked[j].end.ticks!==group[i].end.ticks)throw new Error('Связь вышла за границы фрагмента.');
                            group[i].setSelected(false,false);
                        }
                        s.linked++;
                    }
                }
                return reply({done:s.groups!==null&&s.linkIndex===s.groups.length,completed:s.index+s.trackIndex+s.linkIndex,total:s.boundaries.length+s.tracks.length+(s.groups?s.groups.length:1)});
            }catch(e){state=null;return fail(e);}
        },
        finish:function() {
            try {
                var s=state;if(!s||s.trackIndex!==s.tracks.length||s.groups===null||s.linkIndex!==s.groups.length)throw new Error('Сборка не завершена.');
                var ok=true;
                for(var t=0;t<s.tracks.length;t++) {
                    var clips=s.tracks[t].track.clips,expected=s.expected[t];
                    if(clips.numItems!==expected.length)ok=false;
                    for(var i=0;i<expected.length;i++) {
                        var e=expected[i],c=e.clip;
                        if(Math.abs(c.start.seconds*s.fps-e.start)>.1||Math.abs(c.end.seconds*s.fps-e.end)>.1||c.inPoint.ticks!==e.inp||c.outPoint.ticks!==e.out||c.components.numItems!==e.components)ok=false;
                    }
                }
                if(Math.abs(Number(s.seq.end)/TPS*s.fps-s.frames)>.1)ok=false;
                // Existing timeline markers refer to old times; keep only retained ones and retime.
                var markers=s.seq.markers,m=markers.getFirstMarker(),saved=[];
                while(m){saved.push(m);m=markers.getNextMarker(m);}
                for(var mi=saved.length-1;mi>=0;mi--) {
                    m=saved[mi];var frame=m.start.seconds*s.fps,match=null;
                    for(var si=0;si<s.spans.length;si++)if(frame>=s.spans[si].a&&frame<s.spans[si].b){match=s.spans[si];break;}
                    if(!match)markers.deleteMarker(m);
                    else {var length=Math.max(0,Math.min(m.end.seconds*s.fps,match.b)-frame);var dest=(match.dest+frame-match.a)/s.fps;m.start=dest;m.end=dest+length/s.fps;}
                }
                if(!s.inPlace){s.seq.setInPoint(0);s.seq.setOutPoint(s.frames/s.fps);s.seq.setPlayerPosition('0');}
                var result={name:s.seq.name,id:s.seq.sequenceID,verified:ok,expected:s.frames/s.fps,actual:Number(s.seq.end)/TPS,blocks:s.blocks};state=null;return reply(result);
            }catch(e){state=null;return fail(e);}
        },
        abort:function(){state=null;return reply({ok:true});}
    };
}());
